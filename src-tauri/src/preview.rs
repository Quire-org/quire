//! Extract the largest embedded JPEG preview from a RAW file. Nearly every
//! RAW format (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2 ...) stores a full-size
//! or large JPEG rendition; scanning for JPEG markers is format-agnostic and
//! good enough for a culling view.

use std::fs;
use std::path::Path;

const MAX_SCAN: u64 = 256 * 1024 * 1024;

pub fn embedded_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_SCAN {
        return Err("file too large to scan for a preview".into());
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;

    let mut best: Option<(usize, usize)> = None; // (start, end exclusive)
    let mut i = 0usize;
    while i + 3 < data.len() {
        // SOI followed by an APPn/DQT/SOF marker.
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            if let Some(end) = jpeg_end(&data, i) {
                let len = end - i;
                if best.map(|(s, e)| len > e - s).unwrap_or(true) {
                    best = Some((i, end));
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }

    match best {
        Some((s, e)) if e - s > 2048 => Ok(data[s..e].to_vec()),
        _ => Err("no embedded preview found".into()),
    }
}

/// Walk JPEG segments from `start` to find the byte after EOI.
fn jpeg_end(data: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 2;
    loop {
        if i + 4 > data.len() {
            return None;
        }
        if data[i] != 0xFF {
            return None;
        }
        let marker = data[i + 1];
        match marker {
            0xD8 => return None, // nested SOI: not a real stream
            0xD9 => return Some(i + 2),
            0x01 | 0xD0..=0xD7 => {
                i += 2;
                continue;
            }
            0xDA => {
                // Start of scan: entropy coded data until a marker that is not RSTn / 0x00.
                let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
                i += 2 + seg_len;
                while i + 1 < data.len() {
                    if data[i] == 0xFF {
                        let m = data[i + 1];
                        if m == 0xD9 {
                            return Some(i + 2);
                        }
                        if m != 0x00 && !(0xD0..=0xD7).contains(&m) && m != 0xFF {
                            // Another marker after scan data (multi-scan progressive JPEG).
                            break;
                        }
                    }
                    i += 1;
                }
                if i + 1 >= data.len() {
                    return None;
                }
                continue;
            }
            _ => {
                let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
                if seg_len < 2 {
                    return None;
                }
                i += 2 + seg_len;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal but structurally valid JPEG: SOI, APP0, DQT, SOS with scan data, EOI.
    fn fake_jpeg(scan_len: usize) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]);
        v.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x03, 0x00]);
        v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
        v.extend(std::iter::repeat(0x5A).take(scan_len));
        v.extend_from_slice(&[0xFF, 0x00, 0x12]); // stuffed byte inside scan data
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn finds_largest_embedded_jpeg() {
        let small = fake_jpeg(3000);
        let big = fake_jpeg(9000);
        let mut raw = vec![0x49, 0x49, 0x2A, 0x00];
        raw.extend(std::iter::repeat(0xAB).take(500));
        raw.extend_from_slice(&small);
        raw.extend(std::iter::repeat(0xCD).take(700));
        raw.extend_from_slice(&big);
        raw.extend(std::iter::repeat(0xEF).take(100));

        let p = std::env::temp_dir().join(format!("mediasorter-preview-{}.cr2", std::process::id()));
        fs::write(&p, &raw).unwrap();
        let got = embedded_jpeg(&p).unwrap();
        let _ = fs::remove_file(&p);
        assert_eq!(got, big);
    }
}
