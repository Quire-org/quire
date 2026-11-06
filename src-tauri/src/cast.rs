//! Showing on another device: the picture the viewer shows, on a phone or tablet nearby, in its
//! browser, for as long as the user keeps it on.
//!
//! - Reached only from private (local) addresses, over TLS with a certificate made for the session
//!   (its fingerprint is shown on the Mac, to compare with the one the browser shows).
//! - A device sees nothing until the user allows it on the Mac; the link is random, for this session
//!   only, and dead once stopped. A device is held to the address it asked from; one turned down
//!   can't ask again from there, and only a few may wait at once.
//! - It is only ever handed the picture shown now, as a screen-sized JPEG the app made (never a
//!   file), and told not to keep it. A video shown now is streamed as it is, piece by piece as the
//!   player asks (decrypted in memory from a vault), told not to keep it, and only while it is the
//!   one shown to a device still let in.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

const PAGE: &str = include_str!("cast.html");
/// Devices that may wait for the user's yes at once.
const MAX_WAITING: usize = 3;
/// Connections at once (a browser opens a few).
const MAX_CONNECTIONS: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Pending,
    Allowed,
    Denied,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub state: Access,
}

/// Where a video's bytes come from: its size, its type, and a piece of it read on asking.
#[derive(Clone)]
pub struct VideoSource {
    pub size: u64,
    pub mime: &'static str,
    pub read: Arc<dyn Fn(u64, usize) -> Result<Vec<u8>, String> + Send + Sync>,
}

/// The picture shown now: its JPEG (or the video to stream), and what the device may say about it.
pub struct Frame {
    pub seq: u64,
    pub jpeg: Vec<u8>,
    pub name: String,
    pub video: bool,
    /// The video, when the device's browser can play it (MP4, MOV, WebM).
    pub stream: Option<VideoSource>,
    pub index: usize,
    pub total: usize,
}

pub struct Shared {
    pub token: String,
    pub devices: Vec<Device>,
    pub frame: Option<Frame>,
    /// Back (-1) or on (1), asked by allowed devices, for the viewer to do.
    pub nav: Vec<i32>,
    /// Whether devices may go back and forth (else they only follow).
    pub remote: bool,
    pub denied_ips: HashSet<IpAddr>,
    pub stopped: bool,
}

impl Shared {
    pub fn new(token: String, remote: bool) -> Shared {
        Shared { token, devices: vec![], frame: None, nav: vec![], remote, denied_ips: HashSet::new(), stopped: false }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastUrl {
    /// The network it is on (en0: Wi-Fi, bridge100: a shared connection…).
    pub iface: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastInfo {
    pub urls: Vec<CastUrl>,
    /// The certificate's SHA-256, as Safari shows it ("4F 2A …").
    pub fingerprint: String,
}

/// A running session: dropped (or stopped), it ends.
pub struct Cast {
    pub shared: Arc<Mutex<Shared>>,
    pub info: CastInfo,
}

impl Cast {
    pub fn stop(&self) {
        self.shared.lock().unwrap_or_else(|p| p.into_inner()).stopped = true;
    }
}

impl Drop for Cast {
    fn drop(&mut self) {
        self.stop();
    }
}

/* ---------------- requests ---------------- */

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// The client asked to close after this one.
    pub close: bool,
    /// The bytes asked for ("bytes=0-1023"), for a video.
    pub range: Option<String>,
}

impl Request {
    fn param(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

pub enum Body {
    Bytes(Vec<u8>),
    /// `len` bytes of a video from `start`, read and sent a piece at a time (never all in memory).
    Stream { src: VideoSource, start: u64, len: u64 },
}

pub struct Response {
    pub status: u16,
    pub kind: &'static str,
    pub body: Body,
    /// For a part of a video: first and last byte sent, and its whole size.
    pub range: Option<(u64, u64, u64)>,
}

impl Response {
    fn bytes(status: u16, kind: &'static str, body: Vec<u8>) -> Response {
        Response { status, kind, body: Body::Bytes(body), range: None }
    }
    fn json(v: serde_json::Value) -> Response {
        Response::bytes(200, "application/json", v.to_string().into_bytes())
    }
    fn status(status: u16) -> Response {
        Response::bytes(status, "text/plain; charset=utf-8", Vec::new())
    }
}

/// How much of a video one answer to an open-ended ask carries ("bytes=1000-"): the player asks on.
const STREAM_STEP: u64 = 8 * 1024 * 1024;

/// The bytes a Range header asks for, first and last, within `size`; None when it can't be met.
pub fn range_of(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || size == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (size.saturating_sub(n), size - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { start.saturating_add(STREAM_STEP - 1).min(size - 1) } else { b.parse::<u64>().ok()?.min(size - 1) };
        (start, end)
    };
    (start <= end && start < size).then_some((start, end))
}

/// An address on this side of the router (or this Mac): the only ones answered.
pub fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.is_loopback(),
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return private(IpAddr::V4(m));
            }
            let first = v.segments()[0];
            v.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// A device's id as the page makes it: 32 hex digits.
fn device_id(s: &str) -> Option<&str> {
    (s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())).then_some(s)
}

/// What a request gets. Everything but the page, under the session's random token, needs a device
/// the user allowed, asking from the address it was allowed at.
pub fn handle(shared: &Mutex<Shared>, req: &Request, ip: IpAddr) -> Response {
    let mut s = shared.lock().unwrap_or_else(|p| p.into_inner());
    let Some(rest) = req.path.strip_prefix('/').and_then(|p| p.strip_prefix(s.token.as_str())) else {
        return Response::status(404);
    };
    if s.stopped {
        return if rest == "/state" { Response::json(serde_json::json!({ "state": "ended" })) } else { Response::status(410) };
    }
    let ip_s = ip.to_string();
    match (req.method.as_str(), rest) {
        ("GET", "/") => Response::bytes(200, "text/html; charset=utf-8", PAGE.as_bytes().to_vec()),
        ("POST", "/hello") => {
            let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
            let Some(id) = v.get("device").and_then(|x| x.as_str()).and_then(device_id) else {
                return Response::status(400);
            };
            if let Some(d) = s.devices.iter().find(|d| d.id == id) {
                return Response::json(serde_json::json!({ "state": if d.ip == ip_s { d.state } else { Access::Denied } }));
            }
            if s.denied_ips.contains(&ip) {
                return Response::json(serde_json::json!({ "state": "denied" }));
            }
            let waiting = s.devices.iter().filter(|d| d.state == Access::Pending).count();
            if waiting >= MAX_WAITING || s.devices.iter().any(|d| d.state == Access::Pending && d.ip == ip_s) {
                return Response::json(serde_json::json!({ "state": "busy" }));
            }
            let name: String = v.get("name").and_then(|x| x.as_str()).unwrap_or("A device").chars().filter(|c| !c.is_control()).take(40).collect();
            s.devices.push(Device { id: id.to_string(), name, ip: ip_s, state: Access::Pending });
            Response::json(serde_json::json!({ "state": "pending" }))
        }
        (method, path) => {
            let Some(d) = req.param("d").and_then(device_id).and_then(|id| s.devices.iter().find(|d| d.id == id)) else {
                return Response::status(403);
            };
            if d.ip != ip_s {
                return Response::status(403);
            }
            let state = d.state;
            match (method, path) {
                ("GET", "/state") => {
                    if state != Access::Allowed {
                        return Response::json(serde_json::json!({ "state": state }));
                    }
                    let f = s.frame.as_ref();
                    Response::json(serde_json::json!({
                        "state": "allowed",
                        "seq": f.map(|f| f.seq),
                        "name": f.map(|f| f.name.clone()),
                        "video": f.is_some_and(|f| f.video),
                        "playable": f.is_some_and(|f| f.stream.is_some()),
                        "index": f.map(|f| f.index),
                        "total": f.map(|f| f.total),
                        "remote": s.remote,
                    }))
                }
                ("GET", p) if p.starts_with("/frame/") && p.ends_with("/video") && state == Access::Allowed => {
                    // The video shown now, as much as the player asks for.
                    let seq: Option<u64> = p.strip_prefix("/frame/").and_then(|r| r.strip_suffix("/video")).and_then(|n| n.parse().ok());
                    let Some(src) = s.frame.as_ref().filter(|f| Some(f.seq) == seq).and_then(|f| f.stream.clone()) else {
                        return Response::status(404);
                    };
                    let asked = req.range.as_deref();
                    let (start, end) = match asked {
                        Some(h) => match range_of(h, src.size) {
                            Some(r) => r,
                            None => return Response { status: 416, kind: "text/plain; charset=utf-8", body: Body::Bytes(vec![]), range: Some((0, 0, src.size)) },
                        },
                        None => (0, src.size.saturating_sub(1)),
                    };
                    Response { status: if asked.is_some() { 206 } else { 200 }, kind: src.mime, body: Body::Stream { src: src.clone(), start, len: end + 1 - start }, range: asked.map(|_| (start, end, src.size)) }
                }
                ("GET", p) if p.starts_with("/frame/") && state == Access::Allowed => {
                    let seq: Option<u64> = p["/frame/".len()..].parse().ok();
                    match s.frame.as_ref() {
                        Some(f) if Some(f.seq) == seq && !f.jpeg.is_empty() => Response::bytes(200, "image/jpeg", f.jpeg.clone()),
                        _ => Response::status(404),
                    }
                }
                ("POST", "/go") if state == Access::Allowed => {
                    if !s.remote {
                        return Response::status(403);
                    }
                    let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                    let dir = v.get("dir").and_then(|x| x.as_i64()).unwrap_or(0).signum() as i32;
                    if dir != 0 && s.nav.len() < 10 {
                        s.nav.push(dir);
                    }
                    Response::json(serde_json::json!({ "ok": true }))
                }
                _ => Response::status(403),
            }
        }
    }
}

/* ---------------- the server ---------------- */

/// The private IPv4 addresses of this Mac's networks that are up, with their interface names.
#[cfg(unix)]
pub fn local_addresses() -> Vec<(String, Ipv4Addr)> {
    let mut out = vec![];
    // SAFETY: getifaddrs(3) fills a list the system owns until freeifaddrs; each node and the address
    // and name it points to are read only while the list lives, after the null checks, and an AF_INET
    // address is a sockaddr_in. The list is freed once, at the end.
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            return out;
        }
        let mut p = ifap;
        while !p.is_null() {
            let ifa = &*p;
            let up = (ifa.ifa_flags & libc::IFF_UP as libc::c_uint) != 0 && (ifa.ifa_flags & libc::IFF_LOOPBACK as libc::c_uint) == 0;
            if up && !ifa.ifa_addr.is_null() && (*ifa.ifa_addr).sa_family as i32 == libc::AF_INET {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                if ip.is_private() {
                    out.push((std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned(), ip));
                }
            }
            p = ifa.ifa_next;
        }
        libc::freeifaddrs(ifap);
    }
    out
}

#[cfg(not(unix))]
pub fn local_addresses() -> Vec<(String, Ipv4Addr)> {
    // The address the way out goes from (nothing is sent).
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("192.168.0.1:9").map(|_| s))
        .and_then(|s| s.local_addr())
        .ok()
        .and_then(|a| match a.ip() {
            IpAddr::V4(v) if v.is_private() => Some(vec![("network".to_string(), v)]),
            _ => None,
        })
        .unwrap_or_default()
}

/// A certificate's SHA-256 as Safari shows it: pairs of hex digits.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

fn random_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

/// Starts showing: a certificate for this session, a listener on every network, the link.
pub fn start(remote: bool) -> Result<Cast, String> {
    let addrs = local_addresses();
    if addrs.is_empty() {
        return Err("this Mac isn't on a network a phone could reach".into());
    }
    let mut names: Vec<String> = addrs.iter().map(|(_, ip)| ip.to_string()).collect();
    names.push("localhost".into());
    let made = rcgen::generate_simple_self_signed(names).map_err(|e| format!("certificate: {e}"))?;
    let cert = made.cert.der().clone();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(made.key_pair.serialize_der().into());
    let fp = fingerprint(&cert);
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .map_err(|e| e.to_string())?;
    let config = Arc::new(config);
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| format!("listen: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token();
    let urls = addrs.iter().map(|(iface, ip)| CastUrl { iface: iface.clone(), url: format!("https://{ip}:{port}/{token}/") }).collect();
    let shared = Arc::new(Mutex::new(Shared::new(token, remote)));
    let open = Arc::new(AtomicUsize::new(0));
    let sh = shared.clone();
    std::thread::spawn(move || loop {
        if sh.lock().unwrap_or_else(|p| p.into_inner()).stopped {
            break;
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                // Only from this side of the router, and not too many at once.
                if !private(peer.ip()) || open.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    continue;
                }
                open.fetch_add(1, Ordering::SeqCst);
                let (sh, config, open) = (sh.clone(), config.clone(), open.clone());
                std::thread::spawn(move || {
                    let _ = serve(stream, peer, config, &sh);
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(80)),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    });
    Ok(Cast { shared, info: CastInfo { urls, fingerprint: fp } })
}

/// One connection: TLS, then requests until it closes, goes quiet, or the session ends.
fn serve(stream: TcpStream, peer: SocketAddr, config: Arc<rustls::ServerConfig>, shared: &Mutex<Shared>) -> Result<(), String> {
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(20))).map_err(|e| e.to_string())?;
    let conn = rustls::ServerConnection::new(config).map_err(|e| e.to_string())?;
    let mut tls = rustls::StreamOwned::new(conn, stream);
    let mut buf = Vec::new();
    loop {
        let Some(req) = read_request(&mut tls, &mut buf)? else { return Ok(()) };
        let res = handle(shared, &req, peer.ip());
        let ended = shared.lock().unwrap_or_else(|p| p.into_inner()).stopped || req.close;
        write_response(&mut tls, &res, ended)?;
        if ended {
            tls.conn.send_close_notify();
            let _ = tls.flush();
            return Ok(());
        }
    }
}

/// The next request on a connection (none: it closed). Small requests only.
fn read_request<S: Read>(s: &mut S, buf: &mut Vec<u8>) -> Result<Option<Request>, String> {
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 16 * 1024 {
            return Err("request too large".into());
        }
        let n = s.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("/").to_string();
    let headers: Vec<(&str, &str)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim(), v.trim())).collect();
    let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| *v);
    let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let close = header("connection").is_some_and(|v| v.eq_ignore_ascii_case("close"));
    let range = header("range").map(str::to_string);
    if length > 4096 {
        return Err("body too large".into());
    }
    let start = head_end + 4;
    while buf.len() < start + length {
        let n = s.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = buf[start..start + length].to_vec();
    buf.drain(..start + length);
    let (path, q) = target.split_once('?').unwrap_or((&target, ""));
    let query = q.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
    Ok(Some(Request { method, path: path.to_string(), query, body, close, range }))
}

fn write_response<S: Write>(s: &mut S, r: &Response, close: bool) -> Result<(), String> {
    let reason = match r.status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        410 => "Gone",
        416 => "Range Not Satisfiable",
        _ => "Error",
    };
    let length = match &r.body {
        Body::Bytes(b) => b.len() as u64,
        Body::Stream { len, .. } => *len,
    };
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {length}\r\nCache-Control: no-store, max-age=0\r\nPragma: no-cache\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n",
        r.status, r.kind
    );
    if r.kind.starts_with("text/html") {
        // The page runs only its own script, fetches and plays only from here, and shows only what it drew.
        head.push_str("Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n");
    }
    if r.kind.starts_with("video/") || r.status == 416 {
        head.push_str("Accept-Ranges: bytes\r\n");
    }
    match r.range {
        Some((a, b, size)) if r.status == 206 => head.push_str(&format!("Content-Range: bytes {a}-{b}/{size}\r\n")),
        Some((_, _, size)) if r.status == 416 => head.push_str(&format!("Content-Range: bytes */{size}\r\n")),
        _ => {}
    }
    head.push_str(if close { "Connection: close\r\n\r\n" } else { "Connection: keep-alive\r\n\r\n" });
    s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    match &r.body {
        Body::Bytes(b) => s.write_all(b).map_err(|e| e.to_string())?,
        Body::Stream { src, start, len } => {
            // A piece at a time: never the whole video in memory.
            let mut at = *start;
            let end = start + len;
            while at < end {
                let n = (end - at).min(1024 * 1024) as usize;
                let piece = (src.read)(at, n)?;
                if piece.is_empty() {
                    return Err("the video ended early".into());
                }
                s.write_all(&piece).map_err(|e| e.to_string())?;
                at += piece.len() as u64;
            }
        }
    }
    s.flush().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";

    fn req(method: &str, path: &str, query: &[(&str, &str)], body: &str) -> Request {
        Request { method: method.into(), path: path.into(), query: query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: body.as_bytes().to_vec(), close: false, range: None }
    }
    fn body(r: &Response) -> &[u8] {
        match &r.body {
            Body::Bytes(b) => b,
            Body::Stream { .. } => panic!("a stream"),
        }
    }
    fn json(r: &Response) -> serde_json::Value {
        serde_json::from_slice(body(r)).unwrap()
    }
    fn session() -> Mutex<Shared> {
        let mut s = Shared::new("tok".into(), true);
        s.frame = Some(Frame { seq: 3, jpeg: vec![0xff, 0xd8], name: "beach.jpg".into(), video: false, stream: None, index: 4, total: 10 });
        Mutex::new(s)
    }
    const PHONE: IpAddr = IpAddr::V4(Ipv4Addr::new(172, 20, 10, 2));
    const STRANGER: IpAddr = IpAddr::V4(Ipv4Addr::new(172, 20, 10, 9));

    #[test]
    fn only_private_addresses() {
        for ok in ["192.168.1.4", "10.0.0.2", "172.20.10.2", "169.254.3.3", "127.0.0.1", "fe80::1", "fd00::5", "::ffff:192.168.1.4"] {
            assert!(private(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "172.32.0.1", "2001:4860::1", "::ffff:8.8.8.8"] {
            assert!(!private(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn nothing_without_the_token_or_the_users_yes() {
        let s = session();
        // Wrong or no token: nothing, not even the page.
        assert_eq!(handle(&s, &req("GET", "/", &[], ""), PHONE).status, 404);
        assert_eq!(handle(&s, &req("GET", "/nope/", &[], ""), PHONE).status, 404);
        assert_eq!(handle(&s, &req("GET", "/tok/", &[], ""), PHONE).status, 200);
        // Asking: waits for the Mac; no picture meanwhile.
        assert_eq!(json(&handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{ID}","name":"iPhone"}}"#)), PHONE))["state"], "pending");
        assert_eq!(json(&handle(&s, &req("GET", "/tok/state", &[("d", ID)], ""), PHONE))["state"], "pending");
        assert_eq!(handle(&s, &req("GET", "/tok/frame/3", &[("d", ID)], ""), PHONE).status, 403);
        // Allowed: the picture shown now, only that one.
        s.lock().unwrap().devices[0].state = Access::Allowed;
        let st = json(&handle(&s, &req("GET", "/tok/state", &[("d", ID)], ""), PHONE));
        assert_eq!((st["state"].as_str(), st["seq"].as_u64(), st["index"].as_u64()), (Some("allowed"), Some(3), Some(4)));
        let pic = handle(&s, &req("GET", "/tok/frame/3", &[("d", ID)], ""), PHONE);
        assert_eq!((pic.status, pic.kind, body(&pic).len()), (200, "image/jpeg", 2));
        assert_eq!(handle(&s, &req("GET", "/tok/frame/2", &[("d", ID)], ""), PHONE).status, 404);
        // Its id from another address: no.
        assert_eq!(handle(&s, &req("GET", "/tok/frame/3", &[("d", ID)], ""), STRANGER).status, 403);
        assert_eq!(json(&handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{ID}"}}"#)), STRANGER))["state"], "denied");
    }

    #[test]
    fn turned_down_stays_down_and_few_may_wait() {
        let s = session();
        handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{ID}"}}"#)), STRANGER);
        // A second ask from the same address while one waits: busy.
        assert_eq!(json(&handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{OTHER}"}}"#)), STRANGER))["state"], "busy");
        {
            let mut g = s.lock().unwrap();
            g.devices[0].state = Access::Denied;
            g.denied_ips.insert(STRANGER);
        }
        assert_eq!(json(&handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{OTHER}"}}"#)), STRANGER))["state"], "denied");
        // Three waiting at most.
        for (i, ip) in ["10.0.0.1", "10.0.0.2", "10.0.0.3"].iter().enumerate() {
            let id = format!("{i:0>32}");
            assert_eq!(json(&handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{id}"}}"#)), ip.parse().unwrap()))["state"], "pending");
        }
        assert_eq!(json(&handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{}"}}"#, "9".repeat(32))), "10.0.0.4".parse().unwrap()))["state"], "busy");
    }

    #[test]
    fn going_back_and_forth_only_when_let_and_ended_means_ended() {
        let s = session();
        handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{ID}"}}"#)), PHONE);
        s.lock().unwrap().devices[0].state = Access::Allowed;
        handle(&s, &req("POST", "/tok/go", &[("d", ID)], r#"{"dir":1}"#), PHONE);
        handle(&s, &req("POST", "/tok/go", &[("d", ID)], r#"{"dir":-5}"#), PHONE);
        assert_eq!(s.lock().unwrap().nav, vec![1, -1]);
        s.lock().unwrap().remote = false;
        assert_eq!(handle(&s, &req("POST", "/tok/go", &[("d", ID)], r#"{"dir":1}"#), PHONE).status, 403);
        s.lock().unwrap().stopped = true;
        assert_eq!(json(&handle(&s, &req("GET", "/tok/state", &[("d", ID)], ""), PHONE))["state"], "ended");
        assert_eq!(handle(&s, &req("GET", "/tok/frame/3", &[("d", ID)], ""), PHONE).status, 410);
        assert_eq!(handle(&s, &req("GET", "/tok/", &[], ""), PHONE).status, 410);
    }

    #[test]
    fn requests_are_read_whole_and_one_after_another() {
        let raw = b"POST /tok/go?d=abc HTTP/1.1\r\nHost: x\r\nContent-Length: 9\r\n\r\n{\"dir\":1}GET /tok/state?d=abc HTTP/1.1\r\n\r\n";
        let mut s: &[u8] = raw;
        let mut buf = Vec::new();
        let a = read_request(&mut s, &mut buf).unwrap().unwrap();
        assert_eq!((a.method.as_str(), a.path.as_str(), a.param("d"), a.body.as_slice()), ("POST", "/tok/go", Some("abc"), &b"{\"dir\":1}"[..]));
        let b = read_request(&mut s, &mut buf).unwrap().unwrap();
        assert_eq!((b.method.as_str(), b.path.as_str()), ("GET", "/tok/state"));
        assert!(read_request(&mut s, &mut buf).unwrap().is_none());
    }

    #[test]
    fn a_session_has_its_certificate_and_says_it_is_no_store() {
        let fp = fingerprint(b"cert");
        assert_eq!(fp.split(' ').count(), 32);
        let mut out = Vec::new();
        write_response(&mut out, &Response::status(200), false).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Cache-Control: no-store"));
    }

    /// A 20 MB "video" (each byte its position's low bits), read as the server reads files.
    fn movie() -> VideoSource {
        let size = 20 * 1024 * 1024u64;
        VideoSource { size, mime: "video/mp4", read: Arc::new(move |at, n| Ok((at..(at + n as u64).min(size)).map(|i| (i % 251) as u8).collect())) }
    }

    #[test]
    fn ranges_are_read_as_players_ask() {
        let size = 1000;
        assert_eq!(range_of("bytes=0-1", size), Some((0, 1)));
        assert_eq!(range_of("bytes=100-199", size), Some((100, 199)));
        assert_eq!(range_of("bytes=900-5000", size), Some((900, 999)));
        assert_eq!(range_of("bytes=-100", size), Some((900, 999)));
        assert_eq!(range_of("bytes=500-", size), Some((500, 999)));
        assert_eq!(range_of("bytes=1000-", size), None);
        assert_eq!(range_of("bytes=5-1", size), None);
        assert_eq!(range_of("bytes=0-1,5-6", size), None);
        assert_eq!(range_of("pages=1-2", size), None);
        // Open-ended on a big file: a step at a time.
        assert_eq!(range_of("bytes=0-", 100 * 1024 * 1024), Some((0, STREAM_STEP - 1)));
    }

    #[test]
    fn the_video_shown_now_streams_to_an_allowed_device_and_nothing_else_does() {
        let s = session();
        {
            let mut g = s.lock().unwrap();
            g.frame = Some(Frame { seq: 7, jpeg: vec![], name: "clip.mp4".into(), video: true, stream: Some(movie()), index: 0, total: 1 });
        }
        handle(&s, &req("POST", "/tok/hello", &[], &format!(r#"{{"device":"{ID}"}}"#)), PHONE);
        let ask = |range: Option<&str>, path: &str, ip| {
            let mut r = req("GET", path, &[("d", ID)], "");
            r.range = range.map(str::to_string);
            handle(&s, &r, ip)
        };
        // Not allowed yet: nothing.
        assert_eq!(ask(Some("bytes=0-1"), "/tok/frame/7/video", PHONE).status, 403);
        s.lock().unwrap().devices[0].state = Access::Allowed;
        assert_eq!(json(&handle(&s, &req("GET", "/tok/state", &[("d", ID)], ""), PHONE))["playable"], true);
        // A piece, as Safari asks first; then from the middle (seeking).
        let first = ask(Some("bytes=0-1"), "/tok/frame/7/video", PHONE);
        assert_eq!((first.status, first.kind, first.range), (206, "video/mp4", Some((0, 1, 20 * 1024 * 1024))));
        let mid = ask(Some("bytes=10000000-"), "/tok/frame/7/video", PHONE);
        assert_eq!(mid.range, Some((10_000_000, 10_000_000 + STREAM_STEP - 1, 20 * 1024 * 1024)));
        // What is streamed is exactly that part, with the headers a player needs, and no-store.
        let mut out = Vec::new();
        write_response(&mut out, &ask(Some("bytes=3000000-3000009"), "/tok/frame/7/video", PHONE), false).unwrap();
        let head_end = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&out[..head_end]).to_string();
        assert!(head.starts_with("HTTP/1.1 206") && head.contains("Content-Range: bytes 3000000-3000009/20971520") && head.contains("Accept-Ranges: bytes") && head.contains("no-store"), "{head}");
        assert_eq!(&out[head_end + 4..], &(3_000_000u64..3_000_010).map(|i| (i % 251) as u8).collect::<Vec<_>>()[..]);
        // Beyond its end: can't be met.
        assert_eq!(ask(Some("bytes=999999999-"), "/tok/frame/7/video", PHONE).status, 416);
        // Another address with its id, an older video, or after Stop: nothing.
        assert_eq!(ask(Some("bytes=0-1"), "/tok/frame/7/video", STRANGER).status, 403);
        assert_eq!(ask(Some("bytes=0-1"), "/tok/frame/6/video", PHONE).status, 404);
        s.lock().unwrap().frame = Some(Frame { seq: 8, jpeg: vec![1], name: "next.jpg".into(), video: false, stream: None, index: 1, total: 2 });
        assert_eq!(ask(Some("bytes=0-1"), "/tok/frame/7/video", PHONE).status, 404);
        s.lock().unwrap().stopped = true;
        assert_eq!(ask(Some("bytes=0-1"), "/tok/frame/8/video", PHONE).status, 410);
    }

    /// A client that trusts exactly one certificate, by its fingerprint: as checking it on the phone.
    #[derive(Debug)]
    struct ByFingerprint(String, Arc<rustls::crypto::CryptoProvider>);
    impl rustls::client::danger::ServerCertVerifier for ByFingerprint {
        fn verify_server_cert(&self, cert: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            if fingerprint(cert) == self.0 { Ok(rustls::client::danger::ServerCertVerified::assertion()) } else { Err(rustls::Error::General("another certificate".into())) }
        }
        fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(m, c, d, &self.1.signature_verification_algorithms)
        }
        fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(m, c, d, &self.1.signature_verification_algorithms)
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.1.signature_verification_algorithms.supported_schemes()
        }
    }

    #[test]
    fn serves_over_tls_with_its_own_certificate_and_ends_when_stopped() {
        let Ok(cast) = start(true) else { return }; // no network here: nothing to test
        let url = cast.info.urls[0].url.clone();
        let port: u16 = url.split(':').nth(2).unwrap().split('/').next().unwrap().parse().unwrap();
        let token = url.trim_end_matches('/').rsplit('/').next().unwrap().to_string();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let client = Arc::new(
            rustls::ClientConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .unwrap()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(ByFingerprint(cast.info.fingerprint.clone(), provider)))
                .with_no_client_auth(),
        );
        // What a request gets back; nothing when the connection is refused or cut (the session ended).
        let ask = |path: &str| -> String {
            let conn = rustls::ClientConnection::new(client.clone(), "localhost".try_into().unwrap()).unwrap();
            let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)) else { return String::new() };
            tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut tls = rustls::StreamOwned::new(conn, tcp);
            if write!(tls, "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").is_err() {
                return String::new();
            }
            let mut out = String::new();
            let _ = tls.read_to_string(&mut out);
            out
        };
        let page = ask(&format!("/{token}/"));
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("Content-Security-Policy") && page.contains("no-store") && page.contains("<canvas"));
        assert!(ask("/guess/").starts_with("HTTP/1.1 404"));
        cast.stop();
        std::thread::sleep(Duration::from_millis(300));
        let after = ask(&format!("/{token}/"));
        assert!(after.is_empty() || after.starts_with("HTTP/1.1 410"), "{after}");
    }

    /// A session to look at in a browser (not run with the others): its link written to $CAST_DEMO,
    /// a made-up picture shown, the first device let in, for half a minute.
    #[test]
    #[ignore]
    fn demo_session() {
        let Ok(out) = std::env::var("CAST_DEMO") else { return };
        let cast = start(true).unwrap();
        let mut img = image::RgbImage::new(1600, 1000);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([(x * 255 / 1600) as u8, (y * 255 / 1000) as u8, 160]);
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&img).unwrap();
        cast.shared.lock().unwrap().frame = Some(Frame { seq: 1, jpeg, name: "Sunset over the harbour.jpg".into(), video: false, stream: None, index: 11, total: 48 });
        // Or a video file to stream ($CAST_DEMO_VIDEO), as the app streams one.
        if let Ok(path) = std::env::var("CAST_DEMO_VIDEO") {
            let size = std::fs::metadata(&path).unwrap().len();
            let read = move |at: u64, n: usize| -> Result<Vec<u8>, String> {
                use std::io::{Seek, SeekFrom};
                let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
                let mut buf = Vec::new();
                f.take(n as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
                Ok(buf)
            };
            cast.shared.lock().unwrap().frame = Some(Frame { seq: 2, jpeg: vec![], name: "clip.mp4".into(), video: true, stream: Some(VideoSource { size, mime: "video/mp4", read: Arc::new(read) }), index: 0, total: 1 });
        }
        let url = cast.info.urls[0].url.clone();
        let local = format!("https://127.0.0.1:{}", url.split(':').nth(2).unwrap());
        std::fs::write(&out, local).unwrap();
        for _ in 0..900 {
            std::thread::sleep(Duration::from_millis(100));
            for d in cast.shared.lock().unwrap().devices.iter_mut() {
                d.state = Access::Allowed;
            }
        }
    }
}
