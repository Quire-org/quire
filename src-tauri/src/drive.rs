//! Drive information and health. Capacity and bus come from the OS; SMART
//! data is read through `smartctl` when it is installed and the device
//! supports it. SD cards and most USB readers expose no health counters at
//! all, so the UI must say so plainly rather than guess. A USB drive also
//! says who made it, its firmware and how fast it is connected; the maker's
//! own apps (firmware, sleep, passwords) are found to open, never driven.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

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
    /// Who made it, as its USB connection says ("SanDisk").
    pub vendor: Option<String>,
    pub serial: Option<String>,
    /// Its firmware, as the drive reports it to the computer.
    pub firmware: Option<String>,
    /// The USB version it speaks ("3.2"), and how fast it is connected now, in Gb/s.
    pub usb_version: Option<String>,
    pub link_gbps: Option<f64>,
    /// The maker's own apps installed on this computer (for firmware and settings).
    pub vendor_apps: Vec<VendorApp>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorApp {
    pub name: String,
    pub path: String,
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
    {
        macos_details(&mut info);
        usb_details(&mut info);
        if let Some(v) = info.vendor.clone() {
            info.vendor_apps = vendor_apps(&v);
        }
    }
    info.smartctl_available = which("smartctl").is_some();
    if info.smartctl_available
        && let Some(dev) = info.device.clone() {
            info.smart = Some(smartctl(&dev));
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

/// What the USB device holding the disk says about itself, from the I/O registry: who made it, its
/// serial, its firmware (the drive's own report of it), its USB version and the speed it is
/// connected at.
#[cfg(target_os = "macos")]
fn usb_details(info: &mut DriveInfo) {
    let Some(whole) = info.device.as_deref().map(|d| d.trim_start_matches("/dev/").to_string()) else { return };
    let Ok(out) = Command::new("ioreg").args(["-r", "-c", "IOUSBHostDevice", "-l", "-w0"]).output() else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    if let Some(found) = usb_of(&text, &whole) {
        info.vendor = found.vendor;
        info.serial = found.serial;
        info.firmware = found.firmware;
        info.usb_version = found.usb_version;
        info.link_gbps = found.link_gbps;
        if info.model.is_none() {
            info.model = found.product;
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default, PartialEq)]
struct UsbFound {
    vendor: Option<String>,
    product: Option<String>,
    serial: Option<String>,
    firmware: Option<String>,
    usb_version: Option<String>,
    link_gbps: Option<f64>,
}

/// From `ioreg -r -c IOUSBHostDevice -l`: the USB device whose tree holds disk `whole` (the nearest,
/// as a hub's tree holds its devices' too). Its own properties come before its children's.
#[cfg(any(target_os = "macos", test))]
fn usb_of(text: &str, whole: &str) -> Option<UsbFound> {
    let mut blocks: Vec<String> = vec![];
    for line in text.lines() {
        if line.starts_with("+-o") {
            blocks.push(String::new());
        }
        if let Some(b) = blocks.last_mut() {
            b.push_str(line);
            b.push('\n');
        }
    }
    let want = format!("\"BSD Name\" = \"{whole}\"");
    let block = blocks.iter().filter(|b| b.contains(&want)).min_by_key(|b| b.len())?;
    let prop = |key: &str| -> Option<String> {
        let head = format!("\"{key}\" = ");
        block.lines().find_map(|l| l.trim_start_matches([' ', '|']).strip_prefix(&head).map(|v| v.trim().trim_matches('"').trim().to_string())).filter(|v| !v.is_empty())
    };
    let link_gbps = prop("UsbLinkSpeed")
        .and_then(|v| v.parse::<f64>().ok())
        .map(|bits| bits / 1e9)
        .or_else(|| prop("Device Speed").and_then(|v| v.parse::<usize>().ok()).and_then(|d| [0.0015, 0.012, 0.48, 5.0, 10.0, 20.0].get(d).copied()));
    let usb_version = prop("bcdUSB").and_then(|v| v.parse::<u32>().ok()).filter(|b| *b > 0).map(|b| format!("{}.{}", b >> 8, (b >> 4) & 0xf));
    // The drive's own report (its SCSI inquiry): its firmware, and its serial if USB gave none.
    let chars = block.lines().find(|l| l.contains("\"Device Characteristics\"") && l.contains("\"Product Revision Level\""));
    let firmware = chars.and_then(|l| quoted_in(l, "Product Revision Level"));
    let serial = prop("USB Serial Number").or_else(|| prop("kUSBSerialNumberString")).or_else(|| chars.and_then(|l| quoted_in(l, "Serial Number")));
    Some(UsbFound { vendor: prop("USB Vendor Name").or_else(|| prop("kUSBVendorString")), product: prop("USB Product Name").or_else(|| prop("kUSBProductString")), serial, firmware, usb_version, link_gbps })
}

/// `"key"="value"` inside one of ioreg's inline dictionaries.
#[cfg(any(target_os = "macos", test))]
fn quoted_in(line: &str, key: &str) -> Option<String> {
    let head = format!("\"{key}\"=\"");
    let rest = &line[line.find(&head)? + head.len()..];
    Some(rest[..rest.find('"')?].trim().to_string()).filter(|v| !v.is_empty())
}

/// The drive maker's apps installed here (in Applications), by its name; SanDisk's drives are also
/// looked after by Western Digital's (WD) apps, which made them until 2025.
#[cfg(target_os = "macos")]
fn vendor_apps(vendor: &str) -> Vec<VendorApp> {
    let v = vendor.to_ascii_lowercase();
    let mut names: Vec<String> = vendor.split_whitespace().next().map(|w| vec![w.to_string()]).unwrap_or_default();
    if v.contains("sandisk") || v.contains("western digital") {
        names = vec!["SanDisk".into(), "WD ".into()];
    }
    let home = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications"));
    let mut out: Vec<VendorApp> = vec![];
    for n in names {
        if n.trim().len() < 2 || n.contains(['"', '\\', '*']) {
            continue;
        }
        let query = format!("kMDItemContentType == \"com.apple.application-bundle\" && kMDItemFSName == \"*{n}*\"c");
        let mut cmd = Command::new("mdfind");
        cmd.arg("-onlyin").arg("/Applications");
        if let Some(h) = &home {
            cmd.arg("-onlyin").arg(h);
        }
        let Ok(found) = cmd.arg(query).output() else { continue };
        for line in String::from_utf8_lossy(&found.stdout).lines() {
            let p = PathBuf::from(line.trim());
            // An app, not one inside another app's bundle (its helpers).
            if p.extension().is_none_or(|e| e != "app") || line.matches(".app/").count() > 0 || out.iter().any(|a| a.path == line.trim()) {
                continue;
            }
            let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            out.push(VendorApp { name, path: line.trim().to_string() });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Opens one of the drive maker's apps found by `drive_info` (an app in Applications, nothing else).
pub fn open_vendor_app(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    let home = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications"));
    let in_apps = p.starts_with("/Applications") || home.is_some_and(|h| p.starts_with(h));
    if !in_apps || p.extension().is_none_or(|e| e != "app") || !p.is_dir() || path.contains("..") {
        return Err("that isn't an app in Applications".into());
    }
    Command::new("open").arg(p).status().map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("the app didn't open".into()) })
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
    let mut s = SmartInfo {
        passed: j.pointer("/smart_status/passed").and_then(|v| v.as_bool()),
        temperature_c: j.pointer("/temperature/current").and_then(|v| v.as_i64()),
        power_on_hours: j.pointer("/power_on_time/hours").and_then(|v| v.as_i64()),
        model: j.get("model_name").and_then(|v| v.as_str()).map(String::from),
        percent_used: j.pointer("/nvme_smart_health_information_log/percentage_used").and_then(|v| v.as_i64()),
        ..Default::default()
    };
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
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
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
/// earliest visible symptom of a failing card. `go_on` between files: false
/// stops it (Activity's Stop; it waits there while paused).
pub fn verify_readability(root: &Path, go_on: impl Fn() -> bool, mut progress: impl FnMut(VerifyProgress)) -> VerifyResult {
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
        if !go_on() {
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

/// Free bytes on the volume holding `path`: the mounted disk whose mount point is the longest prefix of it.
pub fn available_space(path: &std::path::Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let path = path.canonicalize().ok()?;
    disks.iter().filter(|d| path.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len()).map(|d| d.available_space())
}

#[cfg(test)]
mod tests {
    use super::*;

    const IOREG: &str = r#"+-o Hub@01000000  <class IOUSBHostDevice, id 0x1, registered>
    {
      "USB Product Name" = "USB3 Hub"
      "UsbLinkSpeed" = 5000000000
    }
    +-o Extreme 55AE@01100000  <class IOUSBHostDevice, id 0x2, registered>
      {
        "USB Product Name" = "Extreme 55AE"
        "USB Vendor Name" = " SanDisk"
        "USB Serial Number" = "3233ABC"
        "bcdUSB" = 800
        "UsbLinkSpeed" = 10000000000
      }
      +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x3>
        +-o IOBlockStorageDevice  <class IOSCSIPeripheralDeviceType00, id 0x4>
          {
            "Device Characteristics" = {"Vendor Name"="SanDisk","Product Name"="Extreme 55AE","Product Revision Level"="3000","Serial Number"="3233ABC"}
          }
          +-o Media  <class IOMedia, id 0x5>
            {
              "BSD Name" = "disk4"
            }
+-o Extreme 55AE@01100000  <class IOUSBHostDevice, id 0x2, registered>
  {
    "USB Product Name" = "Extreme 55AE"
    "USB Vendor Name" = " SanDisk"
    "USB Serial Number" = "3233ABC"
    "bcdUSB" = 800
    "UsbLinkSpeed" = 10000000000
  }
  +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x3>
    +-o IOBlockStorageDevice  <class IOSCSIPeripheralDeviceType00, id 0x4>
      {
        "Device Characteristics" = {"Vendor Name"="SanDisk","Product Name"="Extreme 55AE","Product Revision Level"="3000","Serial Number"="3233ABC"}
      }
      +-o Media  <class IOMedia, id 0x5>
        {
          "BSD Name" = "disk4"
        }
"#;

    #[test]
    fn the_usb_drive_holding_a_disk_says_who_made_it_its_firmware_and_its_speed() {
        let found = usb_of(IOREG, "disk4").unwrap();
        assert_eq!(found.vendor.as_deref(), Some("SanDisk"));
        assert_eq!(found.product.as_deref(), Some("Extreme 55AE"));
        assert_eq!(found.serial.as_deref(), Some("3233ABC"));
        assert_eq!(found.firmware.as_deref(), Some("3000"));
        assert_eq!(found.usb_version.as_deref(), Some("3.2"));
        assert_eq!(found.link_gbps, Some(10.0));
        assert_eq!(usb_of(IOREG, "disk9"), None);
    }

    #[test]
    fn only_an_app_in_applications_opens() {
        assert!(open_vendor_app("/usr/bin/true").is_err());
        assert!(open_vendor_app("/Applications/../tmp/x.app").is_err());
    }
}
