//! One vault object served to ffmpeg over a private address on this Mac only
//! (127.0.0.1, under a random name), decrypted piece by piece as ffmpeg asks
//! for it. Most videos keep their index at the end, so ffmpeg jumps around; it
//! does that with HTTP ranges here, and nothing is ever written in the clear.
//! The server lives as long as the `Served` it returns.

use crate::vault::{self, Keys};
use rand::RngCore;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// How much is decrypted and sent at a time: a whole number of the vault's chunks.
const PIECE: u64 = 16 * vault::CHUNK as u64;

pub struct Served {
    pub url: String,
    stop: Arc<AtomicBool>,
    addr: SocketAddr,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the waiting accept so it sees the stop.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Serve object `id` (`size` bytes in the clear). `ext` ends the address, as a hint to ffmpeg.
pub fn serve(keys: Arc<Keys>, id: String, size: u64, ext: &str) -> Result<Served, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("serve to ffmpeg: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let mut token = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut token);
    let path = format!("/{}.{}", hex::encode(token), if ext.is_empty() { "bin" } else { ext });
    let url = format!("http://127.0.0.1:{}{path}", addr.port());
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let thread = std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else { continue };
            let (keys, id, path) = (keys.clone(), id.clone(), path.clone());
            std::thread::spawn(move || answer(conn, &keys, &id, size, &path));
        }
    });
    Ok(Served { url, stop, addr, thread: Some(thread) })
}

/// One request: the whole object, or the range asked for. Anything else is refused.
fn answer(mut conn: TcpStream, keys: &Keys, id: &str, size: u64, path: &str) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok(read_half) = conn.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    let mut range = None;
    for _ in 0..100 {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':')
            && k.trim().eq_ignore_ascii_case("range")
        {
            range = Some(v.trim().to_string());
        }
    }
    let mut parts = first.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let head = |conn: &mut TcpStream, status: &str, extra: &str, len: u64| {
        let h = format!("HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n{extra}Connection: close\r\n\r\n");
        conn.write_all(h.as_bytes()).is_ok()
    };
    if target != path {
        let _ = head(&mut conn, "404 Not Found", "", 0);
        return;
    }
    if method != "GET" && method != "HEAD" {
        let _ = head(&mut conn, "405 Method Not Allowed", "", 0);
        return;
    }
    let (start, end, ok) = match vault::parse_range(range.as_deref(), size) {
        Some((a, b)) => (a, b, head(&mut conn, "206 Partial Content", &format!("Content-Range: bytes {a}-{}/{size}\r\n", b.saturating_sub(1)), b - a)),
        None if range.is_some() => {
            let _ = head(&mut conn, "416 Range Not Satisfiable", &format!("Content-Range: bytes */{size}\r\n"), 0);
            return;
        }
        None => (0, size, head(&mut conn, "200 OK", "", size)),
    };
    if !ok || method == "HEAD" {
        return;
    }
    let mut pos = start;
    while pos < end {
        // The first piece ends on a piece boundary, so the rest decrypt whole chunks.
        let to = ((pos / PIECE + 1) * PIECE).min(end);
        let Ok(bytes) = keys.read_range(id, size, pos, to) else { return };
        // ffmpeg hangs up when it jumps elsewhere: stop quietly.
        if conn.write_all(&bytes).is_err() {
            return;
        }
        pos = to;
    }
    let _ = conn.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use std::io::Read;

    fn get(url: &str, method: &str, range: Option<&str>) -> (u16, String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_at(rest.find('/').unwrap());
        let mut c = TcpStream::connect(host).unwrap();
        let r = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        write!(c, "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{r}\r\n").unwrap();
        let mut all = Vec::new();
        c.read_to_end(&mut all).unwrap();
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8(all[..split].to_vec()).unwrap();
        let status = head[9..12].parse().unwrap();
        (status, head, all[split + 4..].to_vec())
    }

    #[test]
    fn serves_the_object_whole_and_in_ranges_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("ms-serve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Several chunks and pieces long, not a round number.
        let data: Vec<u8> = (0..(3 * PIECE as usize + 12_345)).map(|i| (i * 31 % 251) as u8).collect();
        std::fs::write(root.join("v.mp4"), &data).unwrap();
        let mut v = Vault::create(&root, "serve test passphrase").unwrap();
        let e = v.add_file(&root.join("v.mp4"), "v.mp4").unwrap();
        std::fs::remove_file(root.join("v.mp4")).unwrap();
        let s = serve(Arc::new(v.keys()), e.id.clone(), e.size, "mp4").unwrap();
        assert!(s.url.starts_with("http://127.0.0.1:") && s.url.ends_with(".mp4"));

        let (st, head, body) = get(&s.url, "GET", None);
        assert_eq!(st, 200);
        assert!(head.contains("Accept-Ranges: bytes"));
        assert_eq!(body, data);

        // Across chunk and piece boundaries, and open-ended to the end.
        for (a, b) in [(70_000u64, 70_099u64), (PIECE - 5, PIECE + 5), (0, 0)] {
            let (st, head, body) = get(&s.url, "GET", Some(&format!("bytes={a}-{b}")));
            assert_eq!(st, 206);
            assert!(head.contains(&format!("Content-Range: bytes {a}-{b}/{}", data.len())));
            assert_eq!(body, &data[a as usize..=b as usize]);
        }
        let tail = data.len() as u64 - 10;
        let (st, _, body) = get(&s.url, "GET", Some(&format!("bytes={tail}-")));
        assert_eq!(st, 206);
        assert_eq!(body, &data[tail as usize..]);

        let (st, head, body) = get(&s.url, "HEAD", None);
        assert_eq!(st, 200);
        assert!(head.contains(&format!("Content-Length: {}", data.len())));
        assert!(body.is_empty());

        let (st, _, _) = get(&s.url, "GET", Some(&format!("bytes={}-", data.len() + 5)));
        assert_eq!(st, 416);
        let wrong = format!("{}x", s.url);
        assert_eq!(get(&wrong, "GET", None).0, 404);
        let other = s.url.rsplit_once('/').unwrap().0.to_string() + "/guess.mp4";
        assert_eq!(get(&other, "GET", None).0, 404);

        // Gone when dropped.
        let addr = s.url.strip_prefix("http://").unwrap().split('/').next().unwrap().to_string();
        drop(s);
        assert!(TcpStream::connect(&addr).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
