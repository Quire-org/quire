//! Edits: rotate, upscale, convert. Images are processed in Rust with the
//! `image` crate when it can decode them; videos, HEIC and other formats go
//! through ffmpeg when it is installed. Results are written to a temp file
//! and then imported through the storage layer, so vault files are handled
//! like plain ones. Nothing is ever edited in place.

use crate::fsx::Ctx;
use crate::media::{self, MediaKind};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub version: Option<String>,
    pub encoders: Vec<String>,
}

fn which(bin: &str) -> Option<PathBuf> {
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "C:\\ffmpeg\\bin"];
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(extra.iter().map(PathBuf::from))
        .flat_map(|d| [d.join(bin), d.join(format!("{bin}.exe"))])
        .find(|p| p.is_file())
}

pub fn tools() -> Tools {
    let Some(ffmpeg) = which("ffmpeg") else { return Tools::default() };
    let version = Command::new(&ffmpeg)
        .arg("-version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.split_whitespace().take(3).collect::<Vec<_>>().join(" ")));
    let encoders = Command::new(&ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| {
            s.lines()
                .filter_map(|l| l.split_whitespace().nth(1).map(String::from))
                .filter(|e| ["libx264", "libx265", "hevc_videotoolbox", "h264_videotoolbox", "libvpx-vp9", "libwebp", "libaom-av1", "libsvtav1"].contains(&e.as_str()))
                .collect()
        })
        .unwrap_or_default();
    Tools { ffmpeg: Some(ffmpeg.to_string_lossy().into_owned()), ffprobe: which("ffprobe").map(|p| p.to_string_lossy().into_owned()), version, encoders }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Op {
    /// Clockwise degrees: 90, 180 or 270.
    Rotate { degrees: u16 },
    /// 2 or 4.
    Upscale { factor: u8 },
    /// Target: jpg, png, webp, tiff, mp4-h264, mp4-h265, webm-vp9, gif. Quality: small, balanced, high.
    Convert { format: String, quality: String },
}

fn suffix_for(op: &Op) -> String {
    match op {
        Op::Rotate { degrees } => format!(" rot{degrees}"),
        Op::Upscale { factor } => format!(" x{factor}"),
        Op::Convert { .. } => String::new(),
    }
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn image_format_for(ext: &str) -> Option<ImageFormat> {
    match ext {
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "webp" => Some(ImageFormat::WebP),
        "tif" | "tiff" => Some(ImageFormat::Tiff),
        "gif" => Some(ImageFormat::Gif),
        "bmp" => Some(ImageFormat::Bmp),
        _ => None,
    }
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let mut dec = reader.into_decoder().map_err(|e| format!("decode: {e}"))?;
    let orientation = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| format!("decode: {e}"))?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn encode(img: &DynamicImage, ext: &str, quality: u8, out: &Path) -> Result<(), String> {
    match ext {
        "jpg" | "jpeg" => {
            let f = std::fs::File::create(out).map_err(|e| e.to_string())?;
            let enc = JpegEncoder::new_with_quality(std::io::BufWriter::new(f), quality);
            img.to_rgb8().write_with_encoder(enc).map_err(|e| e.to_string())
        }
        _ => img.save_with_format(out, image_format_for(ext).ok_or("unsupported output format")?).map_err(|e| e.to_string()),
    }
}

fn jpeg_quality(q: &str) -> u8 {
    match q {
        "small" => 82,
        "high" => 96,
        _ => 91,
    }
}

/// Run ffmpeg with progress reporting (0..1) when the duration is known.
fn run_ffmpeg(tools: &Tools, args: &[String], input: &Path, mut progress: impl FnMut(f32)) -> Result<(), String> {
    let ffmpeg = tools.ffmpeg.as_ref().ok_or("ffmpeg is not installed. On macOS: brew install ffmpeg")?;
    let duration_us: Option<f64> = tools.ffprobe.as_ref().and_then(|p| {
        Command::new(p)
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(input)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .map(|s| s * 1_000_000.0)
    });
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-y"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start ffmpeg: {e}"))?;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
                if let (Ok(t), Some(d)) = (v.trim().parse::<f64>(), duration_us) {
                    if d > 0.0 {
                        progress((t / d).clamp(0.0, 0.99) as f32);
                    }
                }
            }
        }
    }
    let status = child.wait_with_output().map_err(|e| e.to_string())?;
    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
        return Err(format!("ffmpeg failed: {}", err.lines().last().unwrap_or("unknown error")));
    }
    progress(1.0);
    Ok(())
}

fn crf(quality: &str, codec: &str) -> String {
    let base = match quality {
        "small" => 26,
        "high" => 18,
        _ => 22,
    };
    match codec {
        "x265" => (base + 4).to_string(),
        "vp9" => (base + 10).to_string(),
        _ => base.to_string(),
    }
}

/// Produce the edited file at `out` from `input`. Returns the output extension used.
fn produce(tools: &Tools, input: &Path, kind: MediaKind, op: &Op, out_dir: &Path, stem: &str, mut progress: impl FnMut(f32)) -> Result<PathBuf, String> {
    let in_ext = ext_of(input);
    let s = |p: &Path| p.to_string_lossy().into_owned();
    match (kind, op) {
        (MediaKind::Video, Op::Rotate { degrees }) => {
            let out = out_dir.join(format!("{stem}.{in_ext}"));
            // Display-matrix rotation: no re-encoding, players honour it.
            run_ffmpeg(tools, &["-display_rotation".into(), degrees.to_string(), "-i".into(), s(input), "-c".into(), "copy".into(), s(&out)], input, progress)?;
            Ok(out)
        }
        (MediaKind::Video, Op::Upscale { factor }) => {
            let out = out_dir.join(format!("{stem}.mp4"));
            let vf = format!("scale=iw*{factor}:ih*{factor}:flags=lanczos");
            run_ffmpeg(tools, &["-i".into(), s(input), "-vf".into(), vf, "-c:v".into(), "libx264".into(), "-crf".into(), "18".into(), "-preset".into(), "medium".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "copy".into(), s(&out)], input, progress)?;
            Ok(out)
        }
        (MediaKind::Video, Op::Convert { format, quality }) => {
            let (ext, mut args): (&str, Vec<String>) = match format.as_str() {
                "mp4-h264" => ("mp4", vec!["-c:v".into(), "libx264".into(), "-crf".into(), crf(quality, "x264"), "-preset".into(), "medium".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "160k".into(), "-movflags".into(), "+faststart".into()]),
                "mp4-h265" => {
                    let enc = if tools.encoders.iter().any(|e| e == "libx265") { "libx265" } else if tools.encoders.iter().any(|e| e == "hevc_videotoolbox") { "hevc_videotoolbox" } else { return Err("no HEVC encoder in this ffmpeg".into()) };
                    let mut a = vec!["-c:v".into(), enc.into(), "-tag:v".into(), "hvc1".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "160k".into(), "-movflags".into(), "+faststart".into()];
                    if enc == "libx265" {
                        a.extend(["-crf".into(), crf(quality, "x265"), "-preset".into(), "medium".into()]);
                    } else {
                        a.extend(["-q:v".into(), match quality.as_str() { "small" => "50", "high" => "75", _ => "62" }.into()]);
                    }
                    ("mp4", a)
                }
                "webm-vp9" => ("webm", vec!["-c:v".into(), "libvpx-vp9".into(), "-crf".into(), crf(quality, "vp9"), "-b:v".into(), "0".into(), "-row-mt".into(), "1".into(), "-c:a".into(), "libopus".into(), "-b:a".into(), "128k".into()]),
                "gif" => ("gif", vec!["-vf".into(), "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse".into()]),
                "mp3" => ("mp3", vec!["-vn".into(), "-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()]),
                other => return Err(format!("unknown video target {other}")),
            };
            let out = out_dir.join(format!("{stem}.{ext}"));
            let mut full = vec!["-i".into(), s(input)];
            full.append(&mut args);
            full.push(s(&out));
            run_ffmpeg(tools, &full, input, progress)?;
            Ok(out)
        }
        (_, op) => {
            // Still image. Try Rust first; fall back to ffmpeg for formats it cannot read (HEIC, RAW...).
            let (target_ext, quality) = match op {
                Op::Convert { format, quality } => (format.clone(), jpeg_quality(quality)),
                _ => (if image_format_for(&in_ext).is_some() { in_ext.clone() } else { "jpg".to_string() }, 92),
            };
            let out = out_dir.join(format!("{stem}.{target_ext}"));
            let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
            let decoded = if kind == MediaKind::Raw { crate::preview::embedded_jpeg_bytes(&bytes).and_then(|j| decode(&j)) } else { decode(&bytes) };
            match decoded {
                Ok(img) if image_format_for(&target_ext).is_some() => {
                    progress(0.3);
                    let edited = match op {
                        Op::Rotate { degrees: 90 } => img.rotate90(),
                        Op::Rotate { degrees: 180 } => img.rotate180(),
                        Op::Rotate { degrees: 270 } => img.rotate270(),
                        Op::Rotate { .. } => return Err("rotation must be 90, 180 or 270".into()),
                        Op::Upscale { factor } => img.resize_exact(img.width() * *factor as u32, img.height() * *factor as u32, FilterType::Lanczos3),
                        Op::Convert { .. } => img,
                    };
                    progress(0.8);
                    encode(&edited, &target_ext, quality, &out)?;
                    progress(1.0);
                    Ok(out)
                }
                _ => {
                    let mut args = vec!["-i".into(), s(input)];
                    match op {
                        Op::Rotate { degrees } => args.extend(["-vf".into(), match degrees { 90 => "transpose=1", 180 => "transpose=1,transpose=1", _ => "transpose=2" }.into()]),
                        Op::Upscale { factor } => args.extend(["-vf".into(), format!("scale=iw*{factor}:ih*{factor}:flags=lanczos")]),
                        Op::Convert { .. } => {}
                    }
                    if target_ext == "jpg" || target_ext == "jpeg" {
                        args.extend(["-q:v".into(), match quality { q if q >= 95 => "1", q if q <= 85 => "5", _ => "2" }.into()]);
                    }
                    args.extend(["-frames:v".into(), "1".into(), "-update".into(), "1".into(), s(&out)]);
                    run_ffmpeg(tools, &args, input, progress)?;
                    Ok(out)
                }
            }
        }
    }
}

pub struct Outcome {
    pub new_primary: PathBuf,
    /// (old, new) for every original file moved to the trash when replacing.
    pub trashed: Vec<(PathBuf, PathBuf)>,
}

/// Apply `op` to the item whose primary file is `path`. `replace` trashes the
/// original group and gives the result the original name (extension may change).
pub fn apply(ctx: &mut Ctx, tools: &Tools, primary: &Path, files: &[PathBuf], op: &Op, replace: bool, trash_dir: &Path, progress: impl FnMut(f32)) -> Result<Outcome, String> {
    let kind = media::classify(primary).ok_or("not a media file")?;
    let work = std::env::temp_dir().join(format!("mediasorter-edit-{}", hex::encode(rand_bytes(6))));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        // Input: a real file for plain items, a decrypted temp copy for vault items.
        let input = if ctx.vault_id(primary).is_some() {
            let tmp = work.join(primary.file_name().unwrap_or_default());
            std::fs::write(&tmp, ctx.read_all(primary)?).map_err(|e| e.to_string())?;
            tmp
        } else {
            primary.to_path_buf()
        };
        let stem = primary.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let produced = produce(tools, &input, kind, op, &work.join("out").tap_mkdir()?, &format!("{stem}{}", if replace { String::new() } else { suffix_for(op) }), progress)?;

        let dir = primary.parent().unwrap_or(&ctx.root).to_path_buf();
        let mut trashed = vec![];
        if replace {
            let moved = ctx.move_group(files, trash_dir)?;
            trashed = files.iter().cloned().zip(moved).collect();
        }
        // Final name: collision-safe within the item's folder.
        let mut target = dir.join(produced.file_name().unwrap_or_default());
        let mut n = 1;
        while target.exists() || ctx.vault_id(&target).is_some() {
            target = dir.join(crate::ops::with_suffix(&produced, n));
            n += 1;
        }
        let rel = media::rel_key(&ctx.root, &target);
        match ctx.vault.as_deref_mut() {
            Some(v) => {
                v.add_file(&produced, &rel)?;
            }
            None => {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                crate::ops::move_file(&produced, &target).map_err(|e| e.to_string())?;
            }
        }
        Ok(Outcome { new_primary: target, trashed })
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn rand_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

trait TapMkdir {
    fn tap_mkdir(self) -> Result<PathBuf, String>;
}
impl TapMkdir for PathBuf {
    fn tap_mkdir(self) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self).map_err(|e| e.to_string())?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-edit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotate_upscale_convert_images_in_rust() {
        let root = tmp("img");
        let img = DynamicImage::ImageRgb8(ImageBuffer::from_fn(40, 20, |x, y| Rgb([x as u8 * 6, y as u8 * 12, 50])));
        let src = root.join("DCIM/a.png");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        img.save(&src).unwrap();
        let tools = Tools::default(); // no ffmpeg needed for these
        let mut ctx = Ctx::new(&root, None);
        let trash = root.join("_deleted");

        let r = apply(&mut ctx, &tools, &src, &[src.clone()], &Op::Rotate { degrees: 90 }, false, &trash, |_| {}).unwrap();
        assert_eq!(r.new_primary, root.join("DCIM/a rot90.png"));
        let rotated = image::open(&r.new_primary).unwrap();
        assert_eq!((rotated.width(), rotated.height()), (20, 40));
        assert!(src.exists(), "copy mode keeps the original");

        let u = apply(&mut ctx, &tools, &src, &[src.clone()], &Op::Upscale { factor: 2 }, false, &trash, |_| {}).unwrap();
        let up = image::open(&u.new_primary).unwrap();
        assert_eq!((up.width(), up.height()), (80, 40));

        let c = apply(&mut ctx, &tools, &src, &[src.clone()], &Op::Convert { format: "jpg".into(), quality: "high".into() }, true, &trash, |_| {}).unwrap();
        assert_eq!(c.new_primary, root.join("DCIM/a.jpg"));
        assert!(!src.exists(), "replace mode trashes the original");
        assert!(trash.join("a.png").exists());
        assert_eq!(c.trashed.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn edits_work_on_vault_items() {
        let root = tmp("vault");
        let img = DynamicImage::ImageRgb8(ImageBuffer::from_fn(30, 10, |x, _| Rgb([x as u8 * 8, 0, 0])));
        let src = root.join("a.png");
        img.save(&src).unwrap();
        let mut v = crate::vault::Vault::create(&root, "edit test passphrase").unwrap();
        v.add_file(&src, "a.png").unwrap();
        std::fs::remove_file(&src).unwrap();
        let mut ctx = Ctx::new(&root, Some(&mut v));
        let r = apply(&mut ctx, &Tools::default(), &src, &[src.clone()], &Op::Rotate { degrees: 270 }, false, &root.join("_deleted"), |_| {}).unwrap();
        assert_eq!(r.new_primary, root.join("a rot270.png"));
        assert!(!r.new_primary.exists(), "result is encrypted, not on disk");
        let bytes = ctx.read_all(&r.new_primary).unwrap();
        let out = image::load_from_memory(&bytes).unwrap();
        assert_eq!((out.width(), out.height()), (10, 30));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn video_rotate_via_ffmpeg_when_available() {
        let tools = tools();
        if tools.ffmpeg.is_none() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let root = tmp("vid");
        let src = root.join("c.mp4");
        let st = Command::new(tools.ffmpeg.as_ref().unwrap())
            .args(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10", "-pix_fmt", "yuv420p", "-y"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(st.success());
        let mut ctx = Ctx::new(&root, None);
        let mut last = 0.0;
        let r = apply(&mut ctx, &tools, &src, &[src.clone()], &Op::Rotate { degrees: 90 }, false, &root.join("_deleted"), |p| last = p).unwrap();
        assert_eq!(r.new_primary, root.join("c rot90.mp4"));
        assert!(r.new_primary.exists());
        assert!((last - 1.0).abs() < 1e-6);
        let g = apply(&mut ctx, &tools, &src, &[src.clone()], &Op::Convert { format: "gif".into(), quality: "balanced".into() }, false, &root.join("_deleted"), |_| {}).unwrap();
        assert_eq!(g.new_primary, root.join("c.gif"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
