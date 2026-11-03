//! Edits: rotate, upscale, convert. Images are processed in Rust with the
//! `image` crate when it can decode them; videos, HEIC and other formats go
//! through ffmpeg when it is installed. Results are written to a temp file
//! and then imported through the storage layer, so vault files are handled
//! like plain ones. Nothing is ever edited in place.

use crate::fsx::Ctx;
use crate::media::{self, MediaKind};
use crate::jobctl::Control;
use crate::vault::{Keys, Sealed};

/// What a stopped edit says.
const STOPPED: &str = "stopped";
use std::sync::Arc;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Cursor, Read};
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

/// The ffmpeg tools, found once per run (each look starts ffmpeg twice).
pub fn tools() -> Tools {
    static TOOLS: std::sync::OnceLock<Tools> = std::sync::OnceLock::new();
    TOOLS.get_or_init(find_tools).clone()
}

fn find_tools() -> Tools {
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

/// Everything the editor can do, applied in this order: rotate, flip, crop,
/// resize, (video: trim, speed, mute), then encode to `format` or the input
/// format. Crop is normalised 0..1 in the rotated/flipped frame, so the
/// preview and the result agree whatever the pixel size.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Pipeline {
    /// Clockwise degrees: 0, 90, 180, 270.
    pub rotate: u16,
    pub flip_h: bool,
    pub flip_v: bool,
    /// [x, y, w, h] as fractions of the frame after rotate/flip.
    pub crop: Option<[f32; 4]>,
    /// Target width in pixels (height follows the aspect ratio).
    pub resize_width: Option<u32>,
    /// 2 or 4: Lanczos upscale (applied instead of resize_width when set).
    pub upscale: Option<u8>,
    /// Video: keep only [start, end] seconds.
    pub trim: Option<[f64; 2]>,
    /// Video: playback speed factor (0.25..4).
    pub speed: Option<f32>,
    /// Video: drop the audio track.
    pub mute: bool,
    /// Video: write a single still at this time (seconds) instead of a video.
    pub extract_frame: Option<f64>,
    /// jpg, png, webp, tiff | mp4-h264, mp4-h265, webm-vp9, gif, mp3. None = keep.
    pub format: Option<String>,
    /// small, balanced, high (lossy targets only).
    pub quality: String,
}

impl Pipeline {
    fn is_identity(&self) -> bool {
        self.rotate.is_multiple_of(360) && !self.flip_h && !self.flip_v && self.crop.is_none() && self.resize_width.is_none() && self.upscale.is_none() && self.trim.is_none() && self.speed.is_none() && !self.mute && self.extract_frame.is_none() && self.format.is_none()
    }
    /// Short suffix for "save as copy" names.
    pub fn suffix(&self) -> String {
        let mut parts = vec![];
        if !self.rotate.is_multiple_of(360) {
            parts.push(format!("rot{}", self.rotate % 360));
        }
        if self.flip_h || self.flip_v {
            parts.push("flip".into());
        }
        if self.crop.is_some() {
            parts.push("crop".into());
        }
        if let Some(f) = self.upscale {
            parts.push(format!("x{f}"));
        } else if let Some(w) = self.resize_width {
            parts.push(format!("{w}w"));
        }
        if self.trim.is_some() {
            parts.push("trim".into());
        }
        if let Some(sp) = self.speed {
            parts.push(format!("{sp}x"));
        }
        if self.mute {
            parts.push("mute".into());
        }
        if let Some(t) = self.extract_frame {
            parts.push(format!("frame{}", (t * 10.0).round() / 10.0));
        }
        if parts.is_empty() { String::new() } else { format!(" {}", parts.join(" ")) }
    }
    fn needs_video_filters(&self) -> bool {
        !self.rotate.is_multiple_of(360) || self.flip_h || self.flip_v || self.crop.is_some() || self.resize_width.is_some() || self.upscale.is_some() || self.speed.is_some()
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

/// A picture encoded as `ext`, in memory (written to a folder or straight into the vault after).
fn encode_bytes(img: &DynamicImage, ext: &str, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    match ext {
        "jpg" | "jpeg" => {
            let enc = JpegEncoder::new_with_quality(&mut out, quality);
            img.to_rgb8().write_with_encoder(enc).map_err(|e| e.to_string())?;
        }
        _ => img.write_to(&mut Cursor::new(&mut out), image_format_for(ext).ok_or("unsupported output format")?).map_err(|e| e.to_string())?,
    }
    Ok(out)
}

fn jpeg_quality(q: &str) -> u8 {
    match q {
        "small" => 82,
        "high" => 96,
        _ => 91,
    }
}

/// Run ffmpeg with progress reporting (0..1) when the duration is known.
/// How long the input runs, for progress: from ffprobe (a path, or the address a vault item is served at).
fn duration_us(tools: &Tools, input: &str) -> Option<f64> {
    tools.ffprobe.as_ref().and_then(|p| {
        Command::new(p)
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(input)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .map(|s| s * 1_000_000.0)
    })
}

/// A line of ffmpeg's -progress output, turned into a share done.
fn progress_line(line: &str, duration: Option<f64>, progress: &mut impl FnMut(f32)) -> bool {
    let Some((key, v)) = line.split_once('=') else { return false };
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return false;
    }
    if (key == "out_time_us" || key == "out_time_ms")
        && let (Ok(t), Some(d)) = (v.trim().parse::<f64>(), duration)
        && d > 0.0
    {
        progress((t / d).clamp(0.0, 0.99) as f32);
    }
    true
}

/// Run ffmpeg writing a file named in `args`.
fn run_ffmpeg(tools: &Tools, args: &[String], input: &str, ctl: &Arc<Control>, mut progress: impl FnMut(f32)) -> Result<(), String> {
    let ffmpeg = tools.ffmpeg.as_ref().ok_or("ffmpeg is not installed. On macOS: brew install ffmpeg")?;
    let duration = duration_us(tools, input);
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-y"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start ffmpeg: {e}"))?;
    // Paused, resumed and stopped with its Activity job.
    let watch = crate::jobctl::watch_child(ctl.clone(), child.id());
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            progress_line(&line, duration, &mut progress);
        }
    }
    let status = child.wait_with_output().map_err(|e| e.to_string())?;
    drop(watch);
    if ctl.stopped() {
        return Err(STOPPED.into());
    }
    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
        return Err(format!("ffmpeg failed: {}", err.lines().last().unwrap_or("unknown error")));
    }
    progress(1.0);
    Ok(())
}

/// The ffconcat list for an animation's frames (file name, milliseconds each): every frame for its
/// own time, the last named twice so it is shown for its time too.
pub fn frame_list(frames: &[(String, u32)]) -> String {
    let mut out = String::from("ffconcat version 1.0\n");
    for (file, ms) in frames {
        out.push_str(&format!("file '{}'\nduration {:.3}\n", file.replace('\'', "'\\''"), f64::from((*ms).max(10)) / 1000.0));
    }
    if let Some((last, _)) = frames.last() {
        out.push_str(&format!("file '{}'\n", last.replace('\'', "'\\''")));
    }
    out
}

/// Frames in `dir` played at their own timings (an animation from Find), made into an H.264 MP4.
pub fn frames_to_mp4(dir: &Path, frames: &[(String, u32)], out: &Path, ctl: &Arc<Control>) -> Result<(), String> {
    if frames.is_empty() {
        return Err("the animation has no frames".into());
    }
    let list = dir.join("frames.ffconcat");
    std::fs::write(&list, frame_list(frames)).map_err(|e| e.to_string())?;
    let tools = tools();
    let codec = if tools.encoders.iter().any(|e| e == "libx264") { "libx264" } else { "h264_videotoolbox" };
    let mut args: Vec<String> = ["-f", "concat", "-safe", "0", "-i"].iter().map(|s| s.to_string()).collect();
    args.push(list.to_string_lossy().into_owned());
    // Even sizes for yuv420p, and every frame kept at its own time.
    args.extend(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-fps_mode", "vfr", "-c:v", codec, "-pix_fmt", "yuv420p", "-movflags", "+faststart"].iter().map(|s| s.to_string()));
    if codec == "libx264" {
        args.extend(["-crf", "18", "-preset", "medium"].iter().map(|s| s.to_string()));
    }
    args.push(out.to_string_lossy().into_owned());
    run_ffmpeg(&tools, &args, "", ctl, |_| {})
}

/// What a piped ffmpeg run gives: what was made of its output, and how ffmpeg ended.
type Piped<T> = (Result<T, String>, Result<(), String>);

/// Run ffmpeg writing its result to stdout (the args end in "pipe:1"), which `take` reads while it
/// runs (into the vault, say). Progress comes over stderr then. Gives what `take` made and how
/// ffmpeg ended, separately: a result taken from an ffmpeg that failed is the caller's to throw away.
fn run_ffmpeg_to<T: Send>(tools: &Tools, args: &[String], input: &str, ctl: &Arc<Control>, mut progress: impl FnMut(f32), take: impl FnOnce(&mut dyn Read) -> Result<T, String> + Send) -> Result<Piped<T>, String> {
    let ffmpeg = tools.ffmpeg.as_ref().ok_or("ffmpeg is not installed. On macOS: brew install ffmpeg")?;
    let duration = duration_us(tools, input);
    let mut child = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:2", "-y"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start ffmpeg: {e}"))?;
    let watch = crate::jobctl::watch_child(ctl.clone(), child.id());
    let mut out = child.stdout.take().ok_or("no output from ffmpeg")?;
    let err = child.stderr.take().ok_or("no messages from ffmpeg")?;
    let (got, last_err) = std::thread::scope(|sc| {
        let reading = sc.spawn(move || {
            let got = take(&mut out);
            // Whatever is left is drained, so ffmpeg is never stuck on a full pipe.
            let _ = std::io::copy(&mut out, &mut std::io::sink());
            got
        });
        let mut last_err = String::new();
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            if !progress_line(&line, duration, &mut progress) && !line.trim().is_empty() {
                last_err = line;
            }
        }
        (reading.join().unwrap_or_else(|_| Err("reading ffmpeg's output failed".into())), last_err)
    });
    let status = child.wait().map_err(|e| e.to_string())?;
    drop(watch);
    let ended = if ctl.stopped() {
        Err(STOPPED.into())
    } else if status.success() {
        progress(1.0);
        Ok(())
    } else {
        Err(format!("ffmpeg failed: {}", if last_err.is_empty() { "unknown error" } else { &last_err }))
    };
    Ok((got, ended))
}

/// ffmpeg's options for writing `ext` to a pipe. An MP4 or MOV can't go back to write its index,
/// so it is written in fragments (plays everywhere current).
fn pipe_format(ext: &str) -> Vec<String> {
    let v = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match ext {
        "mp4" | "m4v" => v(&["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"]),
        "mov" => v(&["-f", "mov", "-movflags", "frag_keyframe+empty_moov+default_base_moof"]),
        "webm" => v(&["-f", "webm"]),
        "mkv" => v(&["-f", "matroska"]),
        "ts" | "mts" | "m2ts" => v(&["-f", "mpegts"]),
        "jpg" | "jpeg" => v(&["-f", "image2pipe", "-c:v", "mjpeg"]),
        "png" => v(&["-f", "image2pipe", "-c:v", "png"]),
        "webp" => v(&["-f", "image2pipe", "-c:v", "libwebp"]),
        "tif" | "tiff" => v(&["-f", "image2pipe", "-c:v", "tiff"]),
        "bmp" => v(&["-f", "image2pipe", "-c:v", "bmp"]),
        other => v(&["-f", other]),
    }
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

/// Video codec arguments for a target format (or re-encoding in the input container).
fn video_codec_args(tools: &Tools, format: &str, quality: &str) -> Result<(&'static str, Vec<String>), String> {
    Ok(match format {
        "mp4-h264" | "mp4" | "mov" | "m4v" => ("mp4", vec!["-c:v".into(), "libx264".into(), "-crf".into(), crf(quality, "x264"), "-preset".into(), "medium".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "160k".into(), "-movflags".into(), "+faststart".into()]),
        "mp4-h265" => {
            let enc = if tools.encoders.iter().any(|e| e == "libx265") { "libx265" } else if tools.encoders.iter().any(|e| e == "hevc_videotoolbox") { "hevc_videotoolbox" } else { return Err("no HEVC encoder in this ffmpeg".into()) };
            let mut a = vec!["-c:v".into(), enc.into(), "-tag:v".into(), "hvc1".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "160k".into(), "-movflags".into(), "+faststart".into()];
            if enc == "libx265" {
                a.extend(["-crf".into(), crf(quality, "x265"), "-preset".into(), "medium".into()]);
            } else {
                a.extend(["-q:v".into(), match quality { "small" => "50", "high" => "75", _ => "62" }.into()]);
            }
            ("mp4", a)
        }
        "webm-vp9" | "webm" => ("webm", vec!["-c:v".into(), "libvpx-vp9".into(), "-crf".into(), crf(quality, "vp9"), "-b:v".into(), "0".into(), "-row-mt".into(), "1".into(), "-c:a".into(), "libopus".into(), "-b:a".into(), "128k".into()]),
        "gif" => ("gif", vec!["-vf".into(), "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse".into()]),
        "mp3" => ("mp3", vec!["-vn".into(), "-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()]),
        other => return Err(format!("unknown video target {other}")),
    })
}

impl Prepared {
    /// Step 2: run the edit. Reads the input as a file, or (a vault item) served piece by piece;
    /// writes the result to the work folder, or (a vault open) straight into the vault.
    fn make(&self, tools: &Tools, p: &Pipeline, stem: &str, ctl: &Arc<Control>, mut progress: impl FnMut(f32)) -> Result<Produced, String> {
        let kind = self.kind;
        let in_ext = self.ext.clone();
        let input = self.input()?;
        let src = input.arg.clone();
        if kind == MediaKind::Video && p.extract_frame.is_none() {
            // ---- video ----
            let target = p.format.clone().unwrap_or_else(|| in_ext.clone());
            let mut args: Vec<String> = vec![];
            if let Some([start, end]) = p.trim {
                args.extend(["-ss".into(), format!("{start:.3}"), "-to".into(), format!("{end:.3}")]);
            }
            // Lossless path: rotation flag + copy when nothing needs a filter and the container stays.
            let lossless = !p.needs_video_filters() || (!p.rotate.is_multiple_of(360) && !p.flip_h && !p.flip_v && p.crop.is_none() && p.resize_width.is_none() && p.upscale.is_none() && p.speed.is_none());
            if lossless && p.format.is_none() {
                if !p.rotate.is_multiple_of(360) {
                    args.extend(["-display_rotation".into(), (p.rotate % 360).to_string()]);
                }
                args.extend(["-i".into(), src.clone(), "-c".into(), "copy".into()]);
                if p.mute {
                    args.push("-an".into());
                }
                return self.run(tools, args, &src, format!("{stem}.{in_ext}"), &in_ext, ctl, progress);
            }
            let mut vf: Vec<String> = vec![];
            match p.rotate % 360 {
                90 => vf.push("transpose=1".into()),
                180 => vf.push("transpose=1,transpose=1".into()),
                270 => vf.push("transpose=2".into()),
                _ => {}
            }
            if p.flip_h {
                vf.push("hflip".into());
            }
            if p.flip_v {
                vf.push("vflip".into());
            }
            if let Some([x, y, w, h]) = p.crop {
                vf.push(format!("crop=trunc(iw*{w:.4}/2)*2:trunc(ih*{h:.4}/2)*2:iw*{x:.4}:ih*{y:.4}"));
            }
            if let Some(f) = p.upscale {
                vf.push(format!("scale=iw*{f}:ih*{f}:flags=lanczos"));
            } else if let Some(w) = p.resize_width {
                vf.push(format!("scale={w}:-2:flags=lanczos"));
            }
            if let Some(sp) = p.speed {
                vf.push(format!("setpts=PTS/{sp}"));
            }
            let (ext, mut codec) = video_codec_args(tools, &target, &p.quality)?;
            args.extend(["-i".into(), src.clone()]);
            if target == "gif" {
                // gif has its own filter chain; prepend ours
                let own = codec.iter().position(|a| a == "-vf").map(|i| codec.remove(i + 1)).unwrap_or_default();
                codec.retain(|a| a != "-vf");
                vf.push(own);
                args.extend(["-vf".into(), vf.join(",")]);
            } else if !vf.is_empty() {
                args.extend(["-vf".into(), vf.join(",")]);
            }
            if let Some(sp) = p.speed {
                // atempo accepts 0.5..2 per stage; chain for larger factors.
                let mut f = sp as f64;
                let mut stages = vec![];
                while f > 2.0 {
                    stages.push("atempo=2.0".to_string());
                    f /= 2.0;
                }
                while f < 0.5 {
                    stages.push("atempo=0.5".to_string());
                    f *= 2.0;
                }
                stages.push(format!("atempo={f:.4}"));
                if !p.mute && target != "gif" {
                    args.extend(["-af".into(), stages.join(",")]);
                }
            }
            if p.mute {
                args.push("-an".into());
            }
            args.append(&mut codec);
            return self.run(tools, args, &src, format!("{stem}.{ext}"), ext, ctl, progress);
        }

        // ---- still image (or a frame extracted from a video) ----
        let target_ext = p.format.clone().unwrap_or_else(|| if kind == MediaKind::Video { "jpg".into() } else if image_format_for(&in_ext).is_some() { in_ext.clone() } else { "jpg".into() });
        let quality = jpeg_quality(&p.quality);
        let name = format!("{stem}.{target_ext}");
        let source_bytes: Vec<u8> = if kind == MediaKind::Video {
            // Grab the frame with ffmpeg (into memory), then continue in Rust.
            let t = p.extract_frame.unwrap_or(0.0);
            let mut args: Vec<String> = vec!["-ss".into(), format!("{t:.3}"), "-i".into(), src.clone(), "-frames:v".into(), "1".into()];
            args.extend(pipe_format("png"));
            args.push("pipe:1".into());
            let (got, ended) = run_ffmpeg_to(tools, &args, &src, ctl, |_| {}, |r| {
                let mut b = Vec::new();
                r.read_to_end(&mut b).map_err(|e| e.to_string())?;
                Ok(b)
            })?;
            ended?;
            got?
        } else {
            self.bytes()?
        };
        let decoded = if kind == MediaKind::Raw { crate::preview::embedded_jpeg_bytes(&source_bytes).and_then(|j| decode(&j)) } else { decode(&source_bytes) };
        match decoded {
            Ok(mut img) if image_format_for(&target_ext).is_some() => {
                progress(0.3);
                img = match p.rotate % 360 {
                    90 => img.rotate90(),
                    180 => img.rotate180(),
                    270 => img.rotate270(),
                    _ => img,
                };
                if p.flip_h {
                    img = img.fliph();
                }
                if p.flip_v {
                    img = img.flipv();
                }
                if let Some([x, y, w, h]) = p.crop {
                    let (iw, ih) = (img.width() as f32, img.height() as f32);
                    let cx = (x * iw).round().clamp(0.0, iw - 1.0) as u32;
                    let cy = (y * ih).round().clamp(0.0, ih - 1.0) as u32;
                    let cw = (w * iw).round().max(1.0).min(iw - cx as f32) as u32;
                    let ch = (h * ih).round().max(1.0).min(ih - cy as f32) as u32;
                    img = img.crop_imm(cx, cy, cw, ch);
                }
                if let Some(f) = p.upscale {
                    // Two or four times, as the editor offers: anything else would ask for a picture
                    // too big to hold.
                    if !matches!(f, 2 | 4) {
                        return Err(format!("upscale {f}: only 2 or 4"));
                    }
                    img = img.resize_exact(img.width() * f as u32, img.height() * f as u32, FilterType::Lanczos3);
                } else if let Some(w) = p.resize_width {
                    let h = ((w as f64) * (img.height() as f64) / (img.width() as f64)).round().max(1.0) as u32;
                    img = img.resize_exact(w, h, FilterType::Lanczos3);
                }
                progress(0.8);
                let made = self.keep(name, encode_bytes(&img, &target_ext, quality)?)?;
                progress(1.0);
                Ok(made)
            }
            _ => {
                // Rust cannot decode it (HEIC...): let ffmpeg do the whole chain.
                let mut vf: Vec<String> = vec![];
                match p.rotate % 360 {
                    90 => vf.push("transpose=1".into()),
                    180 => vf.push("transpose=1,transpose=1".into()),
                    270 => vf.push("transpose=2".into()),
                    _ => {}
                }
                if p.flip_h {
                    vf.push("hflip".into());
                }
                if p.flip_v {
                    vf.push("vflip".into());
                }
                if let Some([x, y, w, h]) = p.crop {
                    vf.push(format!("crop=iw*{w:.4}:ih*{h:.4}:iw*{x:.4}:ih*{y:.4}"));
                }
                if let Some(f) = p.upscale {
                    vf.push(format!("scale=iw*{f}:ih*{f}:flags=lanczos"));
                } else if let Some(w) = p.resize_width {
                    vf.push(format!("scale={w}:-1:flags=lanczos"));
                }
                let mut args = vec!["-i".into(), src.clone()];
                if !vf.is_empty() {
                    args.extend(["-vf".into(), vf.join(",")]);
                }
                if target_ext == "jpg" || target_ext == "jpeg" {
                    args.extend(["-q:v".into(), match quality { q if q >= 95 => "1", q if q <= 85 => "5", _ => "2" }.into()]);
                }
                args.extend(["-frames:v".into(), "1".into(), "-update".into(), "1".into()]);
                self.run(tools, args, &src, name, &target_ext, ctl, progress)
            }
        }
    }
}

pub struct Outcome {
    pub new_primary: PathBuf,
    /// (old, new) for every original file moved away when replacing.
    pub trashed: Vec<(PathBuf, PathBuf)>,
}

/// Apply `op` to the item whose primary file is `path`. `replace` trashes the
/// original group and gives the result the original name (extension may change).
/// In three steps, so a caller can hold the vault only as each needs it: `prepare`
/// reads, `Prepared::produce` runs the edit (no vault lock at all), `finish` puts
/// the result in place.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn apply(ctx: &mut Ctx, tools: &Tools, primary: &Path, files: &[PathBuf], op: &Pipeline, replace: bool, trash_dir: &Path, progress: impl FnMut(f32)) -> Result<Outcome, String> {
    let p = prepare(ctx, primary, op)?;
    let produced = p.produce(tools, op, replace, &crate::jobctl::none(), progress)?;
    finish(ctx, primary, files, produced, replace, trash_dir)
}

/// Where an edit reads its input: a plain file, or a vault object (served to ffmpeg piece by
/// piece, never decrypted to a file).
enum Source {
    File(PathBuf),
    Vault { keys: Arc<Keys>, id: String, size: u64 },
}

/// An edit's input, ready. A vault open for the folder takes the result straight in, encrypted.
pub struct Prepared {
    src: Source,
    sink: Option<Arc<Keys>>,
    kind: MediaKind,
    stem: String,
    ext: String,
    /// Where results of plain (unencrypted) edits wait for their folder; never made for a vault.
    work: Option<PathBuf>,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if let Some(w) = &self.work {
            let _ = std::fs::remove_dir_all(w);
        }
    }
}

/// The input as ffmpeg takes it; a vault item's server runs while this is held.
struct Input {
    arg: String,
    _served: Option<crate::serve::Served>,
}

/// What an edit made, under the name it should have: a file, or an object already in the vault.
pub struct Produced {
    name: String,
    made: Made,
}

enum Made {
    File(PathBuf),
    Sealed(Sealed, Arc<Keys>),
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Step 1: what the edit reads and where its result goes. Only reads.
pub fn prepare(ctx: &Ctx, primary: &Path, op: &Pipeline) -> Result<Prepared, String> {
    let kind = media::classify(primary).ok_or("not a media file")?;
    if op.is_identity() {
        return Err("nothing to apply".into());
    }
    let stem = primary.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let vault = ctx.vault.as_deref();
    let sink = vault.map(|v| Arc::new(v.keys()));
    let src = match (vault, ctx.vault_id(primary)) {
        (Some(v), Some(id)) => {
            let size = v.entry_by_id(&id).ok_or("unknown object")?.size;
            Source::Vault { keys: Arc::new(v.keys()), id, size }
        }
        _ => Source::File(primary.to_path_buf()),
    };
    let work = if sink.is_none() {
        let w = std::env::temp_dir().join(format!("quire-edit-{}", hex::encode(rand_bytes(6))));
        std::fs::create_dir_all(&w).map_err(|e| e.to_string())?;
        Some(w)
    } else {
        None
    };
    Ok(Prepared { src, sink, kind, stem, ext: ext_of(primary), work })
}

impl Prepared {
    /// Step 2: run the edit.
    pub fn produce(&self, tools: &Tools, op: &Pipeline, replace: bool, ctl: &Arc<Control>, progress: impl FnMut(f32)) -> Result<Produced, String> {
        let stem = format!("{}{}", self.stem, if replace { String::new() } else { op.suffix() });
        self.make(tools, op, &stem, ctl, progress)
    }

    #[cfg(test)]
    pub fn work_dir(&self) -> Option<&Path> {
        self.work.as_deref()
    }

    fn input(&self) -> Result<Input, String> {
        Ok(match &self.src {
            Source::File(p) => Input { arg: p.to_string_lossy().into_owned(), _served: None },
            Source::Vault { keys, id, size } => {
                let served = crate::serve::serve(keys.clone(), id.clone(), *size, &self.ext)?;
                Input { arg: served.url.clone(), _served: Some(served) }
            }
        })
    }

    /// The input's bytes, in memory (pictures).
    fn bytes(&self) -> Result<Vec<u8>, String> {
        match &self.src {
            Source::File(p) => std::fs::read(p).map_err(|e| e.to_string()),
            Source::Vault { keys, id, size } => keys.read_range(id, *size, 0, *size),
        }
    }

    fn out_dir(&self) -> Result<PathBuf, String> {
        self.work.as_ref().ok_or("no work folder")?.join("out").tap_mkdir()
    }

    /// A result made in memory: into the vault, or to the work folder.
    fn keep(&self, name: String, bytes: Vec<u8>) -> Result<Produced, String> {
        match &self.sink {
            Some(keys) => Ok(Produced { name, made: Made::Sealed(keys.seal_stream(&mut &bytes[..], now_ms())?, keys.clone()) }),
            None => {
                let out = self.out_dir()?.join(&name);
                std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
                Ok(Produced { name, made: Made::File(out) })
            }
        }
    }

    /// Run ffmpeg with `args` (input given, output left off): its output piped into the vault as
    /// it comes, or written to the work folder.
    #[allow(clippy::too_many_arguments)]
    fn run(&self, tools: &Tools, mut args: Vec<String>, input: &str, name: String, ext: &str, ctl: &Arc<Control>, progress: impl FnMut(f32)) -> Result<Produced, String> {
        match &self.sink {
            Some(keys) => {
                args.extend(pipe_format(ext));
                args.push("pipe:1".into());
                let (got, ended) = run_ffmpeg_to(tools, &args, input, ctl, progress, |r| keys.seal_stream(r, now_ms()))?;
                match (got, ended) {
                    (Ok(s), Ok(())) => Ok(Produced { name, made: Made::Sealed(s, keys.clone()) }),
                    (Ok(s), Err(e)) => {
                        keys.discard(s);
                        Err(e)
                    }
                    (Err(e), _) => Err(e),
                }
            }
            None => {
                let out = self.out_dir()?.join(&name);
                args.push(out.to_string_lossy().into_owned());
                run_ffmpeg(tools, &args, input, ctl, progress)?;
                Ok(Produced { name, made: Made::File(out) })
            }
        }
    }
}

/// Step 3: the original into `away` when replacing (the trash, or kept for Revert: see versions.rs),
/// and the result in its folder (or the vault).
pub fn finish(ctx: &mut Ctx, primary: &Path, files: &[PathBuf], produced: Produced, replace: bool, away: &Path) -> Result<Outcome, String> {
    let Produced { name, made } = produced;
    // An encrypted result that doesn't make it into the index is not left lying in the vault.
    let drop_made = |made: Made| {
        if let Made::Sealed(s, keys) = made {
            keys.discard(s);
        }
    };
    let dir = primary.parent().unwrap_or(&ctx.root).to_path_buf();
    // Final name: collision-safe within the item's folder (replacing, the original's own place is
    // free once it is put away, so the name is picked then).
    let free_name = |ctx: &Ctx| {
        let mut target = dir.join(&name);
        let mut n = 1;
        while target.exists() || ctx.vault_id(&target).is_some() {
            target = dir.join(crate::ops::with_suffix(Path::new(&name), n));
            n += 1;
        }
        target
    };
    let target = free_name(ctx);
    // The result goes into the folder first, under a name of its own; only once it is there whole is
    // the original put away and the result given its place. So a result that can't be written (the
    // drive full, the vault locked) leaves the picture as it was, and a move that fails brings it
    // back: the picture is never out of sight with nothing in its place.
    let staged = if replace { dir.join(format!(".{}.{}.part", name, std::process::id())) } else { target.clone() };
    let rel = media::rel_key(&ctx.root, &staged);
    match (made, ctx.vault.as_deref_mut()) {
        // commit removes the object itself if it can't take it.
        (Made::Sealed(s, _), Some(v)) => {
            v.commit(s, &rel)?;
            v.flush()?;
        }
        (made @ Made::Sealed(..), None) => {
            drop_made(made);
            return Err("the vault was locked while the edit ran".into());
        }
        (Made::File(f), Some(v)) => {
            v.add_file(&f, &rel)?;
        }
        (Made::File(f), None) => {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            crate::ops::move_file(&f, &staged).map_err(|e| e.to_string())?;
        }
    }
    if !replace {
        return Ok(Outcome { new_primary: target, trashed: vec![] });
    }
    let moved = match ctx.move_group(files, away) {
        Ok(m) => m,
        Err(e) => {
            let _ = ctx.remove(&staged);
            return Err(e);
        }
    };
    let target = free_name(ctx);
    if let Err(e) = ctx.move_one(&staged, &target) {
        for (src, dst) in files.iter().zip(moved.iter()) {
            let _ = ctx.move_one(dst, src);
        }
        let _ = ctx.remove(&staged);
        return Err(e);
    }
    Ok(Outcome { new_primary: target, trashed: files.iter().cloned().zip(moved).collect() })
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

    #[test]
    fn an_animation_frame_list_keeps_each_frames_time() {
        let list = frame_list(&[("000000.jpg".into(), 80), ("it's.jpg".into(), 1200), ("000002.jpg".into(), 0)]);
        assert_eq!(list, "ffconcat version 1.0\nfile '000000.jpg'\nduration 0.080\nfile 'it'\\''s.jpg'\nduration 1.200\nfile '000002.jpg'\nduration 0.010\nfile '000002.jpg'\n");
    }

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

        let r = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { rotate: 90, ..Default::default() }, false, &trash, |_| {}).unwrap();
        assert_eq!(r.new_primary, root.join("DCIM/a rot90.png"));
        let rotated = image::open(&r.new_primary).unwrap();
        assert_eq!((rotated.width(), rotated.height()), (20, 40));
        assert!(src.exists(), "copy mode keeps the original");

        let u = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { upscale: Some(2), ..Default::default() }, false, &trash, |_| {}).unwrap();
        let up = image::open(&u.new_primary).unwrap();
        assert_eq!((up.width(), up.height()), (80, 40));

        // Crop the right half, flip, and convert with replace.
        let cr = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { crop: Some([0.5, 0.0, 0.5, 1.0]), flip_h: true, resize_width: Some(10), ..Default::default() }, false, &trash, |_| {}).unwrap();
        let cropped = image::open(&cr.new_primary).unwrap();
        assert_eq!((cropped.width(), cropped.height()), (10, 10));
        let c = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { format: Some("jpg".into()), quality: "high".into(), ..Default::default() }, true, &trash, |_| {}).unwrap();
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
        let r = apply(&mut ctx, &Tools::default(), &src, std::slice::from_ref(&src), &Pipeline { rotate: 270, ..Default::default() }, false, &root.join("_deleted"), |_| {}).unwrap();
        assert_eq!(r.new_primary, root.join("a rot270.png"));
        assert!(!r.new_primary.exists(), "result is encrypted, not on disk");
        let bytes = ctx.read_all(&r.new_primary).unwrap();
        let out = image::load_from_memory(&bytes).unwrap();
        assert_eq!((out.width(), out.height()), (10, 30));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every file under `dir`, outside the vault's own folder.
    fn plain_files(dir: &Path) -> Vec<PathBuf> {
        crate::media::walk_files(dir, &[dir.join(crate::vault::VAULT_DIR)]).into_iter().map(|f| f.path).collect()
    }

    #[test]
    fn vault_edits_never_write_the_picture_or_video_in_the_clear() {
        let tools = tools();
        if tools.ffmpeg.is_none() || tools.ffprobe.is_none() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let root = tmp("vaultvid");
        // A video with its index at the end (ffmpeg's default for MP4): ffmpeg has to jump to read it.
        let vid = root.join("clip.mp4");
        let st = Command::new(tools.ffmpeg.as_ref().unwrap())
            .args(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x48:rate=10", "-f", "lavfi", "-i", "sine=duration=2", "-pix_fmt", "yuv420p", "-shortest", "-y"])
            .arg(&vid)
            .status()
            .unwrap();
        assert!(st.success());
        let pic = root.join("pic.jpg");
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(60, 40, |x, y| Rgb([x as u8 * 4, y as u8 * 6, 90]))).save(&pic).unwrap();
        let mut v = crate::vault::Vault::create(&root, "edit stream passphrase").unwrap();
        v.add_file(&vid, "clip.mp4").unwrap();
        v.add_file(&pic, "pic.jpg").unwrap();
        std::fs::remove_file(&vid).unwrap();
        std::fs::remove_file(&pic).unwrap();
        // A file that is no video at all, to see a failing ffmpeg leave nothing behind.
        let junk = root.join("junk.mp4");
        std::fs::write(&junk, b"this is not a video at all").unwrap();
        v.add_file(&junk, "junk.mp4").unwrap();
        std::fs::remove_file(&junk).unwrap();
        assert!(plain_files(&root).is_empty());
        let objects = v.objects_dir();
        // Every object, in the folders of the objects folder (see `vault::shard`).
        let object_files = || -> Vec<PathBuf> { std::fs::read_dir(&objects).unwrap().flatten().flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|e| e.path())).collect() };
        let count = || object_files().len();
        let trash = root.join("_deleted");
        let mut ctx = Ctx::new(&root, Some(&mut v));
        let check = root.join("check"); // the test's own look at results (outside the code under test)
        std::fs::create_dir_all(&check).unwrap();
        let probe = |bytes: &[u8], name: &str| -> f64 {
            let f = check.join(name);
            std::fs::write(&f, bytes).unwrap();
            let d = duration_us(&tools, &f.to_string_lossy()).unwrap_or(0.0) / 1e6;
            std::fs::remove_file(&f).unwrap();
            d
        };

        // Nowhere to put a plain copy: a vault edit makes no work folder.
        let p = prepare(&ctx, &vid, &Pipeline { rotate: 90, ..Default::default() }).unwrap();
        assert!(p.work_dir().is_none());
        drop(p);

        // Lossless (stream copy with a rotation flag).
        let mut last = 0.0;
        let r = apply(&mut ctx, &tools, &vid, std::slice::from_ref(&vid), &Pipeline { rotate: 90, ..Default::default() }, false, &trash, |x| last = x).unwrap();
        assert_eq!(r.new_primary, root.join("clip rot90.mp4"));
        assert!((last - 1.0).abs() < 1e-6, "progress reaches the end");
        let d = probe(&ctx.read_all(&r.new_primary).unwrap(), "a.mp4");
        assert!((d - 2.0).abs() < 0.3, "whole clip copied, got {d}s");

        // Re-encoded: trim, mute, crop, speed.
        let t = apply(&mut ctx, &tools, &vid, std::slice::from_ref(&vid), &Pipeline { trim: Some([0.5, 1.5]), mute: true, crop: Some([0.0, 0.0, 0.5, 1.0]), speed: Some(2.0), ..Default::default() }, false, &trash, |_| {}).unwrap();
        let d = probe(&ctx.read_all(&t.new_primary).unwrap(), "t.mp4");
        assert!((d - 0.5).abs() < 0.3, "one second at double speed, got {d}s");

        // Another container, and a still taken from the video.
        let g = apply(&mut ctx, &tools, &vid, std::slice::from_ref(&vid), &Pipeline { format: Some("gif".into()), quality: "balanced".into(), ..Default::default() }, false, &trash, |_| {}).unwrap();
        assert_eq!(g.new_primary, root.join("clip.gif"));
        assert!(image::load_from_memory(&ctx.read_all(&g.new_primary).unwrap()).is_ok());
        let f = apply(&mut ctx, &tools, &vid, std::slice::from_ref(&vid), &Pipeline { extract_frame: Some(1.0), ..Default::default() }, false, &trash, |_| {}).unwrap();
        let still = image::load_from_memory(&ctx.read_all(&f.new_primary).unwrap()).unwrap();
        assert_eq!((still.width(), still.height()), (64, 48));

        // A picture, edited in memory; and replacing the original (which goes to the trash, in the vault).
        let pr = apply(&mut ctx, &tools, &pic, std::slice::from_ref(&pic), &Pipeline { rotate: 90, resize_width: Some(20), ..Default::default() }, true, &trash, |_| {}).unwrap();
        assert_eq!(pr.new_primary, root.join("pic.jpg"));
        let out = image::load_from_memory(&ctx.read_all(&pr.new_primary).unwrap()).unwrap();
        assert_eq!((out.width(), out.height()), (20, 30));
        assert_eq!(pr.trashed.len(), 1);
        assert!(ctx.vault_id(&pr.trashed[0].1).is_some(), "the original stays encrypted in the trash");

        // ffmpeg failing on the input: an error, and no object left from it.
        let before = count();
        assert!(apply(&mut ctx, &tools, &junk, std::slice::from_ref(&junk), &Pipeline { rotate: 90, ..Default::default() }, false, &trash, |_| {}).is_err());
        assert_eq!(count(), before);

        // Through all of it: not one file in the clear outside the test's own folder, every object
        // encrypted, nothing half written.
        std::fs::remove_dir_all(&check).unwrap();
        assert_eq!(plain_files(&root), Vec::<PathBuf>::new());
        for path in object_files() {
            assert_ne!(path.extension().map(|x| x.to_string_lossy().into_owned()), Some("part".into()));
            let head = std::fs::read(&path).unwrap();
            assert_eq!(&head[..4], b"MSV1", "{} is not encrypted", path.display());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_edit_pauses_resumes_and_stops_with_its_job() {
        let tools = tools();
        if tools.ffmpeg.is_none() || tools.ffprobe.is_none() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let root = tmp("ctl");
        let src = root.join("long.mp4");
        let st = Command::new(tools.ffmpeg.as_ref().unwrap())
            .args(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=30:size=640x360:rate=25", "-pix_fmt", "yuv420p", "-y"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(st.success());
        // Heavy enough to still be running while the test pauses and stops it.
        let op = Pipeline { upscale: Some(4), quality: "high".into(), ..Default::default() };
        let job = crate::jobctl::register("edit-ctl-test");
        let ctl = job.ctl.clone();
        let p = prepare(&Ctx::new(&root, None), &src, &op).unwrap();
        let work = p.work_dir().unwrap().to_path_buf();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<f32>::new()));
        let log = seen.clone();
        let running = std::thread::spawn(move || p.produce(&tools, &op, false, &ctl, |f| log.lock().unwrap().push(f)).map(|_| ()));
        let count = || seen.lock().unwrap().len();
        let wait = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
        // Progress past `n`, waited for up to 15 s: a machine busy with the other tests is slow to start.
        let more_than = |n: usize| {
            let t = std::time::Instant::now();
            while count() <= n && t.elapsed() < std::time::Duration::from_secs(15) {
                wait(50);
            }
            count() > n
        };
        assert!(more_than(0), "progress comes in while it runs");
        crate::jobctl::pause("edit-ctl-test", true);
        wait(400); // a line already under way may still arrive
        let paused_at = count();
        wait(1500);
        assert_eq!(count(), paused_at, "no progress while paused");
        assert!(!running.is_finished());
        crate::jobctl::pause("edit-ctl-test", false);
        assert!(more_than(paused_at), "progress again after resuming");
        let t0 = std::time::Instant::now();
        crate::jobctl::stop("edit-ctl-test");
        let r = running.join().unwrap();
        assert_eq!(r, Err(STOPPED.to_string()));
        assert!(t0.elapsed() < std::time::Duration::from_secs(3), "stopped at once, not run out");
        assert!(!work.exists(), "its work folder is gone with it");
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
        let r = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { rotate: 90, ..Default::default() }, false, &root.join("_deleted"), |p| last = p).unwrap();
        assert_eq!(r.new_primary, root.join("c rot90.mp4"));
        assert!(r.new_primary.exists());
        assert!((last - 1.0).abs() < 1e-6);
        let g = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { format: Some("gif".into()), quality: "balanced".into(), ..Default::default() }, false, &root.join("_deleted"), |_| {}).unwrap();
        assert_eq!(g.new_primary, root.join("c.gif"));
        // Trim + mute + crop + speed: re-encode path.
        let t = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { trim: Some([0.2, 0.8]), mute: true, crop: Some([0.0, 0.0, 0.5, 1.0]), speed: Some(2.0), ..Default::default() }, false, &root.join("_deleted"), |_| {}).unwrap();
        assert!(t.new_primary.exists());
        // Frame extraction gives a still.
        let f = apply(&mut ctx, &tools, &src, std::slice::from_ref(&src), &Pipeline { extract_frame: Some(0.5), ..Default::default() }, false, &root.join("_deleted"), |_| {}).unwrap();
        assert_eq!(f.new_primary.extension().unwrap(), "jpg");
        let still = image::open(&f.new_primary).unwrap();
        assert_eq!((still.width(), still.height()), (64, 48));
        let _ = std::fs::remove_dir_all(&root);
    }
}
