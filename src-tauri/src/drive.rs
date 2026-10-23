//! Drive information and health. Capacity and bus come from the OS; SMART
//! data is read through `smartctl` when it is installed and the device
//! supports it. SD cards and most USB readers expose no health counters at
//! all, so the UI must say so plainly rather than guess.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub static VERIFY_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartInfo {
    pub passed: Option<bool>,
    pub temperature_c: Option<i64>,
    pub power_on_hours: Option<i64>,
    /// NVMe percentage_used, or 100 - normalized wear attribute for SATA SSDs.
    pub percent_used: Option<i64>,
    pub reallocated_sectors: Option<i64>,
    pub pending_sectors: Option<i64>,
    pub model: Option<String>,
    pub raw_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub mount_point: String,
    pub device: Option<String>,
    pub file_system: Option<String>,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
    /// "sd", "usb", "nvme", "sata", "thunderbolt", "internal", "unknown"
    pub bus: String,
    pub model: Option<String>,
    pub solid_state: Option<bool>,
    /// What the OS says about SMART: "Verified", "Not Supported", ...
    pub smart_status: Option<String>,
    pub smartctl_available: bool,
    pub smart: Option<SmartInfo>,
}

pub fn drive_info(root: &Path) -> DriveInfo {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut best: Option<&sysinfo::Disk> = None;
    for d in disks.list() {
        let mp = d.mount_point();
        if root.starts_with(mp) && best.map(|b| mp.components().count() > b.mount_point().components().count()).unwrap_or(true) {
            best = Some(d);
        }
    }
    let mut info = DriveInfo { bus: "unknown".into(), ..Default::default() };
    if let Some(d) = best {
        info.mount_point = d.mount_point().to_string_lossy().into_owned();
        info.device = Some(d.name().to_string_lossy().into_owned());
        info.file_system = Some(d.file_system().to_string_lossy().into_owned());
        info.total_bytes = d.total_space();
        info.available_bytes = d.available_space();
        info.removable = d.is_removable();
        info.bus = if d.is_removable() { "usb".into() } else { "internal".into() };
    } else {
        info.mount_point = root.to_string_lossy().into_owned();
    }
    #[cfg(target_os = "macos")]
    macos_details(&mut info);
    info.smartctl_available = which("smartctl").is_some();
    if info.smartctl_available {
        if let Some(dev) = info.device.clone() {
            info.smart = Some(smartctl(&dev));
        }
    }
    info
}

#[cfg(target_os = "macos")]
fn macos_details(info: &mut DriveInfo) {
    let Ok(out) = Command::new("diskutil").arg("info").arg(&info.mount_point).output() else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    let field = |name: &str| -> Option<String> {
        text.lines()
            .find(|l| l.trim_start().starts_with(name))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim().to_string())
    };
    if let Some(p) = field("Protocol") {
        info.bus = match p.to_ascii_lowercase().as_str() {
            s if s.contains("secure digital") || s == "sd" => "sd".into(),
            s if s.contains("usb") => "usb".into(),
            s if s.contains("nvme") || s.contains("pci") => "nvme".into(),
            s if s.contains("sata") => "sata".into(),
            s if s.contains("thunderbolt") => "thunderbolt".into(),
            s if s.contains("apple fabric") => "internal".into(),
            _ => p.to_ascii_lowercase(),
        };
    }
    if let Some(m) = field("Device / Media Name") {
        info.model = Some(m);
    }
    if let Some(s) = field("SMART Status") {
        info.smart_status = Some(s);
    }
    if let Some(s) = field("Solid State") {
        info.solid_state = Some(s.eq_ignore_ascii_case("yes"));
    }
    if let Some(r) = field("Removable Media") {
        info.removable = info.removable || r.to_ascii_lowercase().contains("removable");
    }
    if let Some(node) = field("Device Node") {
        // smartctl wants the whole disk, not the partition slice.
        let whole = node.trim_end_matches(|c: char| c.is_ascii_digit() || c == 's');
        let whole = if whole.len() < node.len() && node.contains('s') { node.rsplit_once('s').map(|(a, _)| a.to_string()).unwrap_or(node.clone()) } else { node.clone() };
        info.device = Some(whole);
    }
}

fn which(bin: &str) -> Option<PathBuf> {
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/sbin", "/usr/bin"];
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(extra.iter().map(PathBuf::from))
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

fn smartctl(device: &str) -> SmartInfo {
    let Some(bin) = which("smartctl") else { return SmartInfo::default() };
    let out = Command::new(bin).args(["-j", "-H", "-A", "-i", device]).output();
    let Ok(out) = out else { return SmartInfo { raw_error: Some("could not run smartctl".into()), ..Default::default() } };
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(j) = serde_json::from_str::<serde_json::Value>(&text) else {
        return SmartInfo { raw_error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()), ..Default::default() };
    };
    let mut s = SmartInfo::default();
    s.passed = j.pointer("/smart_status/passed").and_then(|v| v.as_bool());
    s.temperature_c = j.pointer("/temperature/current").and_then(|v| v.as_i64());
    s.power_on_hours = j.pointer("/power_on_time/hours").and_then(|v| v.as_i64());
    s.model = j.get("model_name").and_then(|v| v.as_str()).map(String::from);
    s.percent_used = j.pointer("/nvme_smart_health_information_log/percentage_used").and_then(|v| v.as_i64());
    if let Some(attrs) = j.pointer("/ata_smart_attributes/table").and_then(|v| v.as_array()) {
        for a in attrs {
            let id = a.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            let norm = a.get("value").and_then(|v| v.as_i64());
            let raw = a.pointer("/raw/value").and_then(|v| v.as_i64());
            match id {
                5 => s.reallocated_sectors = raw,
                197 => s.pending_sectors = raw,
                // Wear levelling / media wearout indicators: normalized value is life left.
                177 | 231 | 233 if s.percent_used.is_none() => s.percent_used = norm.map(|n| 100 - n),
                _ => {}
            }
        }
    }
    if let Some(msgs) = j.pointer("/smartctl/messages").and_then(|v| v.as_array()) {
        let errs: Vec<String> = msgs.iter().filter_map(|m| m.get("string").and_then(|v| v.as_str())).map(String::from).collect();
        if !errs.is_empty() && s.passed.is_none() {
            s.raw_error = Some(errs.join("; "));
        }
    }
    s
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Benchmark {
    pub bytes: u64,
    pub millis: u64,
    pub mb_per_s: f64,
    pub files: usize,
}

/// Sequentially read up to `max_bytes` from the largest files under `root`,
/// bypassing the page cache where the OS allows it.
pub fn read_benchmark(root: &Path, max_bytes: u64) -> Result<Benchmark, String> {
    let mut files: Vec<(u64, PathBuf)> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok().map(|m| (m.len(), e.into_path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut read = 0u64;
    let mut n = 0usize;
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let start = Instant::now();
    for (_, p) in files {
        if read >= max_bytes || start.elapsed().as_secs() >= 6 {
            break;
        }
        let Ok(mut f) = open_uncached(&p) else { continue };
        n += 1;
        loop {
            match std::io::Read::read(&mut f, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(k) => {
                    read += k as u64;
                    if read >= max_bytes {
                        break;
                    }
                }
            }
        }
    }
    let millis = start.elapsed().as_millis().max(1) as u64;
    if read == 0 {
        return Err("no files to read".into());
    }
    Ok(Benchmark { bytes: read, millis, mb_per_s: (read as f64 / 1_048_576.0) / (millis as f64 / 1000.0), files: n })
}

fn open_uncached(p: &Path) -> std::io::Result<std::fs::File> {
    let f = std::fs::File::open(p)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::fcntl(f.as_raw_fd(), libc::F_NOCACHE, 1);
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
        }
    }
    Ok(f)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProgress {
    pub files: usize,
    pub total_files: usize,
    pub bytes: u64,
    pub total_bytes: u64,
    pub errors: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub files: usize,
    pub bytes: u64,
    pub millis: u64,
    pub errors: Vec<(String, String)>,
    pub cancelled: bool,
}

/// Read every byte of every file under `root`. Unreadable files are the
/// earliest visible symptom of a failing card.
pub fn verify_readability(root: &Path, mut progress: impl FnMut(VerifyProgress)) -> VerifyResult {
    VERIFY_CANCEL.store(false, Ordering::SeqCst);
    let files: Vec<(u64, PathBuf)> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok().map(|m| (m.len(), e.into_path())))
        .collect();
    let total_bytes: u64 = files.iter().map(|f| f.0).sum();
    let total_files = files.len();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut bytes = 0u64;
    let mut errors = vec![];
    let start = Instant::now();
    let mut last_report = Instant::now();
    let mut cancelled = false;
    for (i, (_, p)) in files.iter().enumerate() {
        if VERIFY_CANCEL.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        match open_uncached(p) {
            Err(e) => errors.push((p.to_string_lossy().into_owned(), e.to_string())),
            Ok(mut f) => loop {
                match std::io::Read::read(&mut f, &mut buf) {
                    Ok(0) => break,
                    Ok(k) => bytes += k as u64,
                    Err(e) => {
                        errors.push((p.to_string_lossy().into_owned(), e.to_string()));
                        break;
                    }
                }
            },
        }
        if last_report.elapsed().as_millis() > 150 || i + 1 == total_files {
            last_report = Instant::now();
            progress(VerifyProgress {
                files: i + 1,
                total_files,
                bytes,
                total_bytes,
                errors: errors.len(),
                current: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            });
        }
    }
    VerifyResult { files: total_files, bytes, millis: start.elapsed().as_millis() as u64, errors, cancelled }
}
