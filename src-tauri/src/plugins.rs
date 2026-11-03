//! Plugin registry: install, update, state, storage, settings, and the
//! permission-checked network proxy. Plugins are folders with a
//! `plugin.json` manifest and JavaScript that runs in a sandboxed iframe in
//! the webview; this module never executes plugin code.
//!
//! A plugin comes from a GitHub link (downloaded at a pinned commit, updated
//! from the same repository) or a local folder (used in place).
//!
//! Layout under the base folder (app data dir, or QUIRE_PLUGIN_DIR):
//!   installed/<id>/...   files of plugins installed from GitHub
//!   data/<id>/storage.json, settings.json
//!   state.json           enabled, granted permissions, source, vault flag

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_ZIP: u64 = 50 * 1024 * 1024;
const MAX_ENTRY: u64 = 25 * 1024 * 1024;
const MAX_STORAGE: usize = 5 * 1024 * 1024;
const MAX_FETCH_BODY: usize = 20 * 1024 * 1024;

const MAX_FIND_IMAGE: usize = 20 * 1024 * 1024;

/// Permissions a plugin can ask for, besides `network:<host>` and `login:<host>`.
pub const KNOWN_PERMISSIONS: &[&str] = &["media:read", "media:write", "overlay", "viewer", "storage", "engine", "find", "library:storage", "sites"];
/// How many sites the reader may allow a plugin (`sites`).
pub const MAX_SITES: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Settings form: [{ key, type: text|secret|select|boolean|number, label, options?, default?, help? }]
    #[serde(default)]
    pub settings: Vec<serde_json::Value>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    /// Ids of the local engine's models the plugin uses, shown under it in Local models.
    #[serde(default)]
    pub models: Vec<String>,
    /// The plugin's own pipeline: a WebAssembly module in its folder (built with the engine's SDK),
    /// run by the local engine on a picture when the plugin asks (`ms.engine.run`, permission `engine`).
    #[serde(default)]
    pub engine: Option<String>,
    /// Models the plugin brings (not the engine's own): `{ id, name, note, runtimes, files: [{
    /// repository, revision, name, size }] }`, files on Hugging Face (or, while unpublished, put in
    /// the model store's `local/<id>/`). Listed in Local models under the plugin; `models` names them.
    #[serde(default)]
    pub own_models: Vec<serde_json::Value>,
    /// The plugin's logo: a picture in its folder (see `ICON_KINDS`, at most `MAX_ICON`), shown with
    /// its name. A square one shows best.
    #[serde(default)]
    pub icon: Option<String>,
}

/// The kinds of picture a plugin's logo may be, by its file's ending, and how each is served.
const ICON_KINDS: &[(&str, &str)] = &[("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp"), ("gif", "image/gif"), ("svg", "image/svg+xml")];
const MAX_ICON: u64 = 256 * 1024;

fn icon_kind(rel: &str) -> Option<&'static str> {
    let ext = rel.rsplit_once('.')?.1.to_ascii_lowercase();
    ICON_KINDS.iter().find(|(e, _)| *e == ext).map(|(_, mime)| *mime)
}

/// A plugin's logo as a `data:` picture: read from its folder, when it is there and small enough.
fn icon_data(dir: &Path, rel: &str) -> Option<String> {
    use base64::Engine;
    let mime = icon_kind(rel)?;
    let path = dir.join(rel);
    if fs::metadata(&path).ok()?.len() > MAX_ICON {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(fs::read(path).ok()?)))
}

fn default_entry() -> String {
    "index.js".into()
}

fn safe_rel(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

pub fn valid_host(h: &str) -> bool {
    let bare = h.strip_prefix("*.").unwrap_or(h);
    !bare.is_empty()
        && bare.len() <= 253
        && bare.contains('.')
        && !bare.starts_with('.')
        && !bare.ends_with('.')
        && bare.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

pub fn valid_id(id: &str) -> bool {
    (2..=48).contains(&id.len()) && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn validate(m: &Manifest) -> Result<(), String> {
    if !valid_id(&m.id) {
        return Err(format!("invalid plugin id \"{}\" (use 2-48 of a-z, 0-9 and -)", m.id));
    }
    if m.name.trim().is_empty() || m.name.len() > 60 {
        return Err("plugin name must be 1-60 characters".into());
    }
    semver::Version::parse(&m.version).map_err(|e| format!("version \"{}\" is not semver: {e}", m.version))?;
    if !safe_rel(&m.entry) || !m.entry.ends_with(".js") {
        return Err(format!("entry \"{}\" must be a relative .js path inside the plugin", m.entry));
    }
    for p in &m.permissions {
        match p.strip_prefix("network:").or_else(|| p.strip_prefix("login:")) {
            Some(host) if valid_host(host) => {}
            Some(host) => return Err(format!("invalid host \"{host}\" in \"{p}\"")),
            None if KNOWN_PERMISSIONS.contains(&p.as_str()) => {}
            None => return Err(format!("unknown permission \"{p}\"")),
        }
    }
    if m.own_models.len() > 10 {
        return Err("a plugin brings at most 10 models of its own".into());
    }
    for om in &m.own_models {
        let id = om["id"].as_str().unwrap_or("");
        if !valid_id(id) || om["name"].as_str().is_none_or(|n| n.trim().is_empty()) || !om["files"].as_array().is_some_and(|f| !f.is_empty() && f.len() <= 20 && f.iter().all(|f| f["name"].as_str().is_some_and(safe_rel))) {
            return Err(format!("each of ownModels needs an id (a-z, 0-9, -), a name and 1 to 20 files with relative names (\"{id}\")"));
        }
        if !m.models.iter().any(|x| x == id) {
            return Err(format!("ownModels' \"{id}\" must be named in models too"));
        }
    }
    if let Some(engine) = &m.engine
        && (!safe_rel(engine) || !engine.ends_with(".wasm"))
    {
        return Err(format!("engine \"{engine}\" must be a relative .wasm path inside the plugin"));
    }
    if let Some(icon) = &m.icon
        && (!safe_rel(icon) || icon_kind(icon).is_none())
    {
        return Err(format!("icon \"{icon}\" must be a relative path inside the plugin to a PNG, JPEG, WebP, GIF or SVG picture"));
    }
    if let Some(min) = &m.min_app_version {
        let min = semver::Version::parse(min).map_err(|e| format!("minAppVersion: {e}"))?;
        let app = semver::Version::parse(APP_VERSION).expect("app version is semver");
        if app < min {
            return Err(format!("needs Quire {min} or newer (this is {app})"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub enabled: bool,
    /// Off by default: the plugin gets nothing from encrypted folders.
    #[serde(default)]
    pub allow_vault: bool,
    /// Permissions the user approved (a subset of the manifest's).
    #[serde(default)]
    pub granted: Vec<String>,
    /// What the user entered, normalised: a GitHub URL or a folder path.
    #[serde(default)]
    pub source: String,
    /// Local plugins: files are served live from this folder.
    #[serde(default)]
    pub linked: Option<String>,
    /// GitHub plugins: the repository updates come from, and the installed commit.
    #[serde(default)]
    pub github: Option<GitHubRef>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub installed_at: u64,
}

/// Sites the reader allowed each plugin (with `sites`), each a domain it may contact with its
/// subdomains and open in a window of its own: the open library's, kept with it (in its vault when
/// it has one) and told here when it opens, never written on this computer.
static SITES: std::sync::Mutex<Option<HashMap<String, Vec<String>>>> = std::sync::Mutex::new(None);

/// A plugin's sites for the library open, checked: domains (no patterns), at most MAX_SITES.
pub fn set_sites(id: &str, list: Vec<String>) -> Result<Vec<String>, String> {
    let mut clean: Vec<String> = Vec::new();
    for d in list {
        let d = d.trim().to_ascii_lowercase();
        if !valid_host(&d) || d.starts_with("*.") {
            return Err(format!("\"{d}\" isn't a site's domain"));
        }
        if !clean.contains(&d) {
            clean.push(d);
        }
    }
    if clean.len() > MAX_SITES {
        return Err(format!("a plugin may have at most {MAX_SITES} sites"));
    }
    SITES.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(id.to_string(), clean.clone());
    Ok(clean)
}

fn sites_of(id: &str) -> Vec<String> {
    SITES.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|s| s.get(id).cloned()).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: Option<Manifest>,
    pub id: String,
    pub state: PluginState,
    pub dir: String,
    pub error: Option<String>,
    /// Its logo (plugin.json's `icon`) as a `data:` picture, ready to show.
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub id: String,
    pub current: String,
    pub latest: String,
    /// Permissions the new version asks for that are not granted yet.
    pub new_permissions: Vec<String>,
    pub manifest: Manifest,
    /// The commit that will be installed.
    pub commit: String,
}

/// Result of looking at a source before installing it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    pub manifest: Manifest,
    /// "github" or "local"
    pub kind: String,
    /// Normalised link or path, shown to the user.
    pub location: String,
}

/// Base URLs for GitHub; tests point them at a local server.
#[derive(Debug, Clone)]
pub struct GitHubHosts {
    pub api: String,
    pub raw: String,
}

impl Default for GitHubHosts {
    fn default() -> Self {
        GitHubHosts { api: "https://api.github.com".into(), raw: "https://raw.githubusercontent.com".into() }
    }
}

pub struct Registry {
    pub base: PathBuf,
    pub gh: GitHubHosts,
}

/* ---------------- sources ---------------- */

/// A plugin in a GitHub repository: `https://github.com/owner/repo`, optionally
/// `/tree/<branch or tag>/<folder>` for a branch, tag or a plugin in a subfolder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRef {
    pub owner: String,
    pub repo: String,
    /// Branch, tag or commit; None follows the default branch.
    #[serde(default)]
    pub git_ref: Option<String>,
    /// Folder inside the repository that holds plugin.json.
    #[serde(default)]
    pub path: Option<String>,
}

impl GitHubRef {
    pub fn url(&self) -> String {
        let mut u = format!("https://github.com/{}/{}", self.owner, self.repo);
        if self.git_ref.is_some() || self.path.is_some() {
            u.push_str(&format!("/tree/{}", self.git_ref.as_deref().unwrap_or("HEAD")));
        }
        if let Some(p) = &self.path {
            u.push('/');
            u.push_str(p);
        }
        u
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    GitHub(GitHubRef),
    Local(PathBuf),
}

fn gh_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Read what the user pasted: a GitHub link or a folder path.
pub fn parse_source(input: &str) -> Result<Source, String> {
    let t = input.trim().trim_matches(|c| c == '"' || c == '\'');
    if t.is_empty() {
        return Err("Paste a GitHub link or a folder path.".into());
    }
    // Folder paths: absolute, home-relative, file:// or a Windows drive.
    let win_drive = t.len() > 2 && t.as_bytes()[1] == b':' && t.as_bytes()[0].is_ascii_alphabetic() && (t.as_bytes()[2] == b'\\' || t.as_bytes()[2] == b'/');
    if t.starts_with('/') || t.starts_with("~/") || t == "~" || t.starts_with("file://") || t.starts_with("\\\\") || win_drive {
        let raw = t.strip_prefix("file://").unwrap_or(t);
        let raw = percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned();
        let path = match raw.strip_prefix('~') {
            Some(rest) => PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "no home folder")?).join(rest.trim_start_matches(['/', '\\'])),
            None => PathBuf::from(raw),
        };
        // A path to plugin.json itself means its folder.
        let path = if path.file_name().map(|n| n == "plugin.json").unwrap_or(false) { path.parent().map(Path::to_path_buf).unwrap_or(path) } else { path };
        return Ok(Source::Local(path));
    }
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))
        .unwrap_or(t);
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let rest = rest
        .strip_prefix("github.com/")
        .or_else(|| rest.strip_prefix("git@github.com:"))
        .ok_or("That is not a GitHub link or a folder path. Use https://github.com/owner/repo or a full path such as /Users/you/my-plugin.")?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return Err("A GitHub link needs the owner and repository: https://github.com/owner/repo".into());
    }
    let owner = segs[0].to_string();
    let repo = segs[1].trim_end_matches(".git").to_string();
    if !gh_name(&owner) || !gh_name(&repo) {
        return Err("That GitHub link has an unusual owner or repository name.".into());
    }
    let mut git_ref = None;
    let mut path = None;
    if segs.len() > 2 {
        if !matches!(segs[2], "tree" | "blob") || segs.len() < 4 {
            return Err("Use a link to the repository or to a folder in it (…/tree/main/folder).".into());
        }
        let r = segs[3];
        if !r.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
            return Err("That branch or tag name is not supported.".into());
        }
        if r != "HEAD" {
            git_ref = Some(r.to_string());
        }
        let mut p: Vec<&str> = segs[4..].to_vec();
        if p.last() == Some(&"plugin.json") {
            p.pop();
        }
        if !p.is_empty() {
            let joined = p.join("/");
            let decoded = percent_encoding::percent_decode_str(&joined).decode_utf8_lossy().into_owned();
            if !safe_rel(&decoded) {
                return Err("That folder path in the link is not supported.".into());
            }
            path = Some(decoded);
        }
    }
    Ok(Source::GitHub(GitHubRef { owner, repo, git_ref, path }))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            continue;
        }
        let to = dst.join(&name);
        if ft.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Extract a plugin archive into `dest`. Rejects absolute paths, `..`, symlinks
/// and oversized entries. Returns the folder that holds plugin.json: `sub`
/// inside the archive's root (or its single top-level folder, as GitHub
/// archives have).
pub fn extract_zip(bytes: &[u8], dest: &Path, sub: Option<&str>) -> Result<PathBuf, String> {
    if bytes.len() as u64 > MAX_ZIP {
        return Err("plugin archive is larger than 50 MB".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a zip archive: {e}"))?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        // Its name as the archive wrote it (zip 9 refuses one that isn't valid text).
        let name = f.name().map_err(|e| format!("a file in the archive has an unreadable name: {e}"))?.into_owned();
        let rel = f.enclosed_name().ok_or_else(|| format!("unsafe path in archive: {name}"))?;
        if f.is_symlink() {
            return Err(format!("symlinks are not allowed in plugins: {name}"));
        }
        let out = dest.join(&rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if f.size() > MAX_ENTRY {
            return Err(format!("{name} is larger than 25 MB"));
        }
        total += f.size();
        if total > MAX_ZIP * 2 {
            return Err("plugin archive expands to more than 100 MB".into());
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.by_ref().take(MAX_ENTRY + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.len() as u64 > MAX_ENTRY {
            return Err(format!("{name} is larger than 25 MB"));
        }
        fs::write(&out, buf).map_err(|e| e.to_string())?;
    }
    let at = |d: &Path| match sub {
        Some(s) => d.join(s),
        None => d.to_path_buf(),
    };
    if at(dest).join("plugin.json").is_file() {
        return Ok(at(dest));
    }
    let dirs: Vec<PathBuf> = fs::read_dir(dest)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !e.file_name().to_string_lossy().starts_with("__MACOSX"))
        .map(|e| e.path())
        .collect();
    match dirs.as_slice() {
        [one] if at(one).join("plugin.json").is_file() => Ok(at(one)),
        _ => Err(match sub {
            Some(s) => format!("no plugin.json in the folder {s}"),
            None => "no plugin.json at the top of the repository. Link to the folder that holds it (…/tree/main/folder).".into(),
        }),
    }
}

/* ---------------- HTTP ---------------- */

fn client() -> Result<reqwest::blocking::Client, String> {
    client_with_timeout(120)
}

/// Plugin requests get longer: a vision request with thinking can take minutes.
fn client_with_timeout(secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("Quire/{APP_VERSION}"))
        .timeout(std::time::Duration::from_secs(secs))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

/// Downloads for install/update: https anywhere, plain http only to this machine (tests).
fn check_download_url(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("bad URL: {e}"))?;
    let local = matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"));
    match u.scheme() {
        "https" => Ok(u),
        "http" if local => Ok(u),
        _ => Err("plugin downloads must use https".into()),
    }
}

fn http_get(url: &str, accept: Option<&str>) -> Result<Vec<u8>, String> {
    let u = check_download_url(url)?;
    let mut req = client()?.get(u);
    if let Some(a) = accept {
        req = req.header("Accept", a);
    }
    let resp = req.send().map_err(|e| format!("could not reach GitHub: {e}"))?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Err("not found on GitHub. Check the link; private repositories are not supported.".into());
    }
    if status == 403 || status == 429 {
        return Err("GitHub is limiting requests from this network. Try again in a while.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub answered HTTP {status}"));
    }
    read_capped(resp, MAX_ZIP as usize, "the download is larger than 50 MB")
}

/// A response body read up to `cap` bytes, and refused past it, rather than taken whole first.
fn read_capped(resp: reqwest::blocking::Response, cap: usize, over: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(over.into());
    }
    let mut buf = Vec::new();
    resp.take(cap as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() > cap {
        return Err(over.into());
    }
    Ok(buf)
}

impl Registry {
    /// The commit a link points at right now. Installs and updates use exactly
    /// this commit, so the manifest that was approved is the code that runs.
    fn gh_commit(&self, r: &GitHubRef) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/commits/{}", self.gh.api, r.owner, r.repo, r.git_ref.as_deref().unwrap_or("HEAD"));
        let body = http_get(&url, Some("application/vnd.github.sha"))?;
        let sha = String::from_utf8_lossy(&body).trim().to_ascii_lowercase();
        if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("GitHub did not return a commit for that link".into());
        }
        Ok(sha)
    }

    fn gh_manifest(&self, r: &GitHubRef, commit: &str) -> Result<Manifest, String> {
        let sub = r.path.as_ref().map(|p| format!("{p}/")).unwrap_or_default();
        let url = format!("{}/{}/{}/{}/{}plugin.json", self.gh.raw, r.owner, r.repo, commit, sub);
        let bytes = http_get(&url, None).map_err(|e| if e.starts_with("not found") { format!("no plugin.json in {}", r.url()) } else { e })?;
        let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("plugin.json: {e}"))?;
        validate(&m)?;
        Ok(m)
    }

    fn gh_archive(&self, r: &GitHubRef, commit: &str) -> Result<Vec<u8>, String> {
        http_get(&format!("{}/repos/{}/{}/zipball/{}", self.gh.api, r.owner, r.repo, commit), None)
    }
}

/// Is `url` allowed for a plugin holding `granted` permissions? https only,
/// host must match a granted `network:<host>` (or `network:*.<domain>`).
pub fn url_allowed(granted: &[String], url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("bad URL: {e}"))?;
    if u.scheme() != "https" {
        return Err("plugins may only use https".into());
    }
    let host = u.host_str().ok_or("URL has no host")?.to_ascii_lowercase();
    if host_granted(granted, "network:", &host) { Ok(u) } else { Err(format!("this plugin is not allowed to contact {host}")) }
}

/// May a plugin open `url` as a sign-in page? https, on a host it holds `login:<host>` for.
pub fn login_allowed(granted: &[String], url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("bad URL: {e}"))?;
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if u.scheme() == "https" && host_granted(granted, "login:", &host) { Ok(u) } else { Err(format!("this plugin may not open a sign-in page on {host}")) }
}

fn host_granted(granted: &[String], kind: &str, host: &str) -> bool {
    granted.iter().filter_map(|p| p.strip_prefix(kind)).any(|h| match h.strip_prefix("*.") {
        Some(domain) => host == domain || host.ends_with(&format!(".{domain}")),
        None => host == h,
    })
}

/// A client for Find's images and downloads: each redirect is checked against the plugin's hosts too.
fn find_client(granted: &[String], secs: u64) -> Result<reqwest::blocking::Client, String> {
    let granted = granted.to_vec();
    reqwest::blocking::Client::builder()
        .user_agent(format!("Quire/{APP_VERSION}"))
        .timeout(std::time::Duration::from_secs(secs))
        .redirect(reqwest::redirect::Policy::custom(move |a| {
            if a.previous().len() >= 5 || url_allowed(&granted, a.url().as_str()).is_err() { a.stop() } else { a.follow() }
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn with_headers(mut b: reqwest::blocking::RequestBuilder, headers: &BTreeMap<String, String>) -> reqwest::blocking::RequestBuilder {
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if ["cookie", "host", "connection", "content-length", "authorization"].contains(&lk.as_str()) {
            continue;
        }
        b = b.header(k, v);
    }
    b
}

/// An image for Find's grid or preview, with the headers its plugin says the host wants (a Referer).
pub fn find_image(granted: &[String], url: &str, headers: &BTreeMap<String, String>) -> Result<Vec<u8>, String> {
    let u = url_allowed(granted, url)?;
    let resp = with_headers(find_client(granted, 60)?.get(u), headers).send().map_err(|e| format!("could not load the image: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the image was refused (status {})", resp.status().as_u16()));
    }
    read_capped(resp, MAX_FIND_IMAGE, "the image is larger than 20 MB")
}

/// Download `url` to `dest` in pieces (a temporary file, renamed when whole). `more(bytes so far)`
/// is asked after each piece: false stops it (paused jobs wait inside it).
pub fn download_to(granted: &[String], url: &str, headers: &BTreeMap<String, String>, dest: &Path, mut more: impl FnMut(u64) -> bool) -> Result<u64, String> {
    use std::io::{Read, Write};
    let u = url_allowed(granted, url)?;
    let mut resp = with_headers(find_client(granted, 600)?.get(u), headers).send().map_err(|e| format!("could not download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the download was refused (status {})", resp.status().as_u16()));
    }
    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = 0u64;
    let result = loop {
        let n = match resp.read(&mut buf) {
            Ok(n) => n,
            Err(e) => break Err(format!("the download broke off: {e}")),
        };
        if n == 0 {
            break Ok(());
        }
        if let Err(e) = out.write_all(&buf[..n]) {
            break Err(e.to_string());
        }
        got += n as u64;
        if !more(got) {
            break Err("stopped".to_string());
        }
    };
    drop(out);
    match result {
        Ok(()) => std::fs::rename(&part, dest).map(|_| got).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Request body as text (JSON etc.).
    #[serde(default)]
    pub body: Option<String>,
    /// Or as bytes, in base64 (a picture in a form, say).
    #[serde(default)]
    pub body_base64: Option<String>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    /// UTF-8 body, or None when the body is binary (then see body_base64).
    pub body: Option<String>,
    pub body_base64: Option<String>,
}

pub fn plugin_fetch(granted: &[String], req: &FetchRequest) -> Result<FetchResponse, String> {
    use base64::Engine;
    let u = url_allowed(granted, &req.url)?;
    let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes()).map_err(|_| "bad HTTP method")?;
    // Each redirect is checked against the plugin's hosts too: an allowed host answering with a
    // redirect must not carry the request (and its headers) elsewhere.
    let mut b = find_client(granted, 300)?.request(method, u);
    for (k, v) in &req.headers {
        // Hop-by-hop headers are not the plugin's business. A cookie (its own sign-in on a website,
        // kept from its sign-in window) only ever goes to its own hosts: the address is checked above.
        let lk = k.to_ascii_lowercase();
        if ["host", "connection", "content-length"].contains(&lk.as_str()) {
            continue;
        }
        b = b.header(k, v);
    }
    if let Some(bytes) = &req.body_base64 {
        b = b.body(base64::engine::general_purpose::STANDARD.decode(bytes).map_err(|_| "the body isn't base64")?);
    } else if let Some(body) = &req.body {
        b = b.body(body.clone());
    }
    let resp = b.send().map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status().as_u16();
    let headers = resp.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string()))).collect();
    let bytes = read_capped(resp, MAX_FETCH_BODY, "response is larger than 20 MB")?;
    Ok(match String::from_utf8(bytes.to_vec()) {
        Ok(s) => FetchResponse { status, headers, body: Some(s), body_base64: None },
        Err(_) => FetchResponse { status, headers, body: None, body_base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)) },
    })
}

/* ---------------- registry ---------------- */

impl Registry {
    pub fn new(base: PathBuf) -> Registry {
        let _ = fs::create_dir_all(base.join("installed"));
        let _ = fs::create_dir_all(base.join("data"));
        Registry { base, gh: GitHubHosts::default() }
    }

    fn state_path(&self) -> PathBuf {
        self.base.join("state.json")
    }
    pub fn load_state(&self) -> BTreeMap<String, PluginState> {
        fs::read(self.state_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    fn save_state(&self, s: &BTreeMap<String, PluginState>) -> Result<(), String> {
        write_atomic(&self.state_path(), &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)
    }
    pub fn installed_dir(&self, id: &str) -> PathBuf {
        self.base.join("installed").join(id)
    }
    pub fn data_dir(&self, id: &str) -> PathBuf {
        self.base.join("data").join(id)
    }

    /// Folder the plugin's files are served from (linked folder in dev mode).
    pub fn root_of(&self, id: &str) -> Option<PathBuf> {
        if !valid_id(id) {
            return None;
        }
        let st = self.load_state();
        let s = st.get(id)?;
        let dir = s.linked.as_ref().map(PathBuf::from).unwrap_or_else(|| self.installed_dir(id));
        dir.is_dir().then_some(dir)
    }

    pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
        let bytes = fs::read(dir.join("plugin.json")).map_err(|_| format!("no plugin.json in {}", dir.display()))?;
        let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("plugin.json: {e}"))?;
        validate(&m)?;
        if let Some(icon) = &m.icon {
            match fs::metadata(dir.join(icon)) {
                Ok(meta) if meta.is_file() && meta.len() <= MAX_ICON => {}
                Ok(meta) if meta.is_file() => return Err(format!("icon \"{icon}\" is over {} KB", MAX_ICON / 1024)),
                _ => return Err(format!("plugin.json names the icon \"{icon}\", which isn't in the plugin")),
            }
        }
        if !dir.join(&m.entry).is_file() {
            return Err(format!("entry file {} is missing", m.entry));
        }
        Ok(m)
    }

    pub fn manifest(&self, id: &str) -> Result<Manifest, String> {
        Self::read_manifest(&self.root_of(id).ok_or("plugin is not installed")?)
    }

    /// The plugin's pipeline (its WebAssembly module, inside its folder), the models it uses, and the
    /// ones it brings (`ownModels`).
    pub fn engine_of(&self, id: &str) -> Result<(PathBuf, Vec<String>, Vec<serde_json::Value>), String> {
        let root = self.root_of(id).ok_or("plugin is not installed")?;
        let m = Self::read_manifest(&root)?;
        let rel = m.engine.ok_or("this plugin has no pipeline of its own (\"engine\" in its plugin.json)")?;
        let module = root.join(&rel);
        if !module.is_file() {
            return Err(format!("the plugin's pipeline {rel} is missing from its folder"));
        }
        Ok((module, m.models, m.own_models))
    }

    /// The models installed plugins bring, for the engine's catalogue (Local models lists and downloads them).
    pub fn own_models(&self) -> Vec<serde_json::Value> {
        let mut out: Vec<serde_json::Value> = Vec::new();
        for p in self.list() {
            for om in p.manifest.map(|m| m.own_models).unwrap_or_default() {
                if !out.iter().any(|o| o["id"] == om["id"]) {
                    out.push(om);
                }
            }
        }
        out
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.load_state()
            .into_iter()
            .map(|(id, state)| {
                let dir = state.linked.clone().map(PathBuf::from).unwrap_or_else(|| self.installed_dir(&id));
                let (manifest, error) = match Self::read_manifest(&dir) {
                    Ok(m) => (Some(m), None),
                    Err(e) => (None, Some(e)),
                };
                let icon = manifest.as_ref().and_then(|m| icon_data(&dir, m.icon.as_deref()?));
                PluginInfo { manifest, id, state, dir: dir.to_string_lossy().into_owned(), error, icon }
            })
            .collect()
    }

    /// Granted permissions intersected with what the current manifest asks for.
    pub fn effective_permissions(&self, id: &str) -> Vec<String> {
        let st = self.load_state();
        let Some(s) = st.get(id) else { return vec![] };
        let Ok(m) = self.manifest(id) else { return vec![] };
        if !s.enabled {
            return vec![];
        }
        let mut out: Vec<String> = s.granted.iter().filter(|p| m.permissions.contains(p)).cloned().collect();
        // Each site the reader allowed: it and its subdomains, to contact and to open in a window.
        if out.iter().any(|p| p == "sites") {
            for d in &sites_of(id) {
                out.push(format!("network:*.{d}"));
                out.push(format!("login:*.{d}"));
            }
        }
        out
    }

    fn commit_install(&self, m: &Manifest, files: &Path, source: String, granted: Vec<String>, link: bool, github: Option<(GitHubRef, String)>) -> Result<(), String> {
        let mut st = self.load_state();
        let prev = st.get(&m.id).cloned();
        if let Some(p) = &prev {
            // Same id from somewhere else: replace it, but never delete a linked folder.
            if p.linked.is_none() && link {
                let _ = fs::remove_dir_all(self.installed_dir(&m.id));
            }
        }
        if !link {
            let target = self.installed_dir(&m.id);
            let staging = self.base.join("installed").join(format!(".{}.new", m.id));
            let backup = self.base.join("installed").join(format!(".{}.old", m.id));
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_dir_all(&backup);
            copy_tree(files, &staging)?;
            if target.exists() {
                fs::rename(&target, &backup).map_err(|e| e.to_string())?;
            }
            if let Err(e) = fs::rename(&staging, &target) {
                let _ = fs::rename(&backup, &target);
                return Err(e.to_string());
            }
            let _ = fs::remove_dir_all(&backup);
        }
        let granted: Vec<String> = granted.into_iter().filter(|p| m.permissions.contains(p)).collect();
        let (github, commit) = match github {
            Some((r, c)) => (Some(r), Some(c)),
            None => (None, None),
        };
        st.insert(
            m.id.clone(),
            PluginState {
                enabled: prev.as_ref().map(|p| p.enabled).unwrap_or(true),
                allow_vault: prev.as_ref().map(|p| p.allow_vault).unwrap_or(false),
                granted,
                source,
                linked: link.then(|| files.to_string_lossy().into_owned()),
                github,
                commit,
                installed_at: now_ms(),
            },
        );
        self.save_state(&st)
    }

    /// Look at a GitHub link or folder without installing anything.
    pub fn inspect(&self, input: &str) -> Result<Inspected, String> {
        match parse_source(input)? {
            Source::Local(dir) => {
                let m = Self::read_manifest(&dir)?;
                Ok(Inspected { manifest: m, kind: "local".into(), location: dir.to_string_lossy().into_owned() })
            }
            Source::GitHub(r) => {
                let commit = self.gh_commit(&r)?;
                let m = self.gh_manifest(&r, &commit)?;
                Ok(Inspected { manifest: m, kind: "github".into(), location: r.url() })
            }
        }
    }

    /// Install from a GitHub link (downloaded) or a folder (used in place).
    /// `expect_id`, when given, must match the plugin found there.
    pub fn install(&self, input: &str, granted: Vec<String>, expect_id: Option<&str>) -> Result<Manifest, String> {
        match parse_source(input)? {
            Source::Local(dir) => {
                let m = Self::read_manifest(&dir)?;
                check_id(&m, expect_id)?;
                self.commit_install(&m, &dir, dir.to_string_lossy().into_owned(), granted, true, None)?;
                Ok(m)
            }
            Source::GitHub(r) => {
                let commit = self.gh_commit(&r)?;
                self.install_github(&r, &commit, granted, expect_id)
            }
        }
    }

    fn install_github(&self, r: &GitHubRef, commit: &str, granted: Vec<String>, expect_id: Option<&str>) -> Result<Manifest, String> {
        let bytes = self.gh_archive(r, commit)?;
        let tmp = self.base.join(format!(".extract-{}", hex::encode(rand_bytes(6))));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let res = (|| {
            let root = extract_zip(&bytes, &tmp, r.path.as_deref())?;
            let m = Self::read_manifest(&root)?;
            check_id(&m, expect_id)?;
            self.commit_install(&m, &root, r.url(), granted, false, Some((r.clone(), commit.to_string())))?;
            Ok(m)
        })();
        let _ = fs::remove_dir_all(&tmp);
        res
    }

    /// Is a newer version on GitHub? Local folders are always current.
    /// A new commit counts only when plugin.json has a higher version.
    pub fn check_update(&self, id: &str) -> Result<Option<UpdateInfo>, String> {
        let st = self.load_state();
        let Some(s) = st.get(id) else { return Err("plugin is not installed".into()) };
        let Some(r) = s.github.clone() else { return Ok(None) };
        let commit = self.gh_commit(&r)?;
        if s.commit.as_deref() == Some(commit.as_str()) {
            return Ok(None);
        }
        let current = self.manifest(id)?;
        let remote = self.gh_manifest(&r, &commit)?;
        if remote.id != id {
            return Err(format!("the repository now holds the plugin \"{}\"", remote.id));
        }
        let cur = semver::Version::parse(&current.version).map_err(|e| e.to_string())?;
        let new = semver::Version::parse(&remote.version).map_err(|e| e.to_string())?;
        if new <= cur {
            return Ok(None);
        }
        let new_permissions = remote.permissions.iter().filter(|p| !s.granted.contains(p)).cloned().collect();
        Ok(Some(UpdateInfo { id: id.into(), current: current.version, latest: remote.version.clone(), new_permissions, manifest: remote, commit }))
    }

    /// Install the newer version. New permissions are granted only with `accept_new`;
    /// otherwise they stay denied and the plugin runs without them.
    pub fn apply_update(&self, id: &str, accept_new: bool) -> Result<Manifest, String> {
        let info = self.check_update(id)?.ok_or("already up to date")?;
        let st = self.load_state();
        let prev = st.get(id).cloned().unwrap_or_default();
        let r = prev.github.clone().ok_or("not installed from GitHub")?;
        let mut granted = prev.granted.clone();
        if accept_new {
            granted.extend(info.new_permissions.iter().cloned());
        }
        self.install_github(&r, &info.commit, granted, Some(id))
    }

    pub fn set_state(&self, id: &str, enabled: Option<bool>, allow_vault: Option<bool>, granted: Option<Vec<String>>) -> Result<PluginState, String> {
        let mut st = self.load_state();
        let s = st.get_mut(id).ok_or("plugin is not installed")?;
        if let Some(v) = enabled {
            s.enabled = v;
        }
        if let Some(v) = allow_vault {
            s.allow_vault = v;
        }
        if let Some(g) = granted {
            s.granted = g;
        }
        let out = s.clone();
        self.save_state(&st)?;
        Ok(out)
    }

    pub fn uninstall(&self, id: &str, keep_data: bool) -> Result<(), String> {
        if !valid_id(id) {
            return Err("bad id".into());
        }
        let mut st = self.load_state();
        let s = st.remove(id).ok_or("plugin is not installed")?;
        if s.linked.is_none() {
            let _ = fs::remove_dir_all(self.installed_dir(id));
        }
        if !keep_data {
            let _ = fs::remove_dir_all(self.data_dir(id));
        }
        self.save_state(&st)
    }

    fn read_json(&self, id: &str, file: &str) -> serde_json::Value {
        fs::read(self.data_dir(id).join(file)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(serde_json::Value::Object(Default::default()))
    }

    pub fn storage_get(&self, id: &str) -> serde_json::Value {
        self.read_json(id, "storage.json")
    }

    pub fn storage_set(&self, id: &str, key: &str, value: serde_json::Value) -> Result<(), String> {
        let mut v = self.storage_get(id);
        let obj = v.as_object_mut().ok_or("storage is corrupted")?;
        if value.is_null() {
            obj.remove(key);
        } else {
            obj.insert(key.into(), value);
        }
        let bytes = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_STORAGE {
            return Err("plugin storage is limited to 5 MB".into());
        }
        write_atomic(&self.data_dir(id).join("storage.json"), &bytes)
    }

    pub fn settings_get(&self, id: &str) -> serde_json::Value {
        self.read_json(id, "settings.json")
    }

    pub fn settings_set(&self, id: &str, values: serde_json::Value) -> Result<(), String> {
        if !values.is_object() {
            return Err("settings must be an object".into());
        }
        write_atomic(&self.data_dir(id).join("settings.json"), &serde_json::to_vec_pretty(&values).map_err(|e| e.to_string())?)
    }
}

fn check_id(m: &Manifest, expect: Option<&str>) -> Result<(), String> {
    match expect {
        Some(id) if m.id != id => Err(format!("found the plugin \"{}\", expected \"{id}\"", m.id)),
        _ => Ok(()),
    }
}

fn rand_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

/* ---------------- serving plugin files ---------------- */

pub const FRAME_HTML: &str = include_str!("plugin_frame.html");
pub const SDK_JS: &str = include_str!("../../src/plugins/sdk.js");

/// The content security policy of one plugin's frame, sent with everything served for that plugin.
/// It is the frame that it binds (the header means nothing on a script or a picture); plugin `id`'s
/// files are only ever shown in its own frame. A plugin's frame is a sandboxed iframe (`allow-scripts`
/// alone), so its origin is opaque and `'self'` would match nothing: its own files are named by where
/// the app serves them, `msplugin://localhost/<id>/` (`http://msplugin.localhost/<id>/` on Windows),
/// the path keeping one plugin's frame from loading another plugin's files.
///
/// What each part allows, and why:
/// - `default-src 'none'`: nothing that isn't named below. The frame is hidden; a plugin's UI (panels,
///   buttons, toasts) is drawn by the app from what the plugin sends by postMessage.
/// - `script-src <own files>`: the frame shell loads the SDK and the plugin's entry script from the
///   plugin's folder; both are files, so no inline script is needed, and none is allowed.
/// - `style-src 'unsafe-inline' <own files>`: a plugin may set styles in its (unseen) document.
/// - `img-src data: blob: <own files>`: pictures a plugin makes in its frame (canvases, decoded bytes
///   the app handed it) and its own assets. No remote hosts: plugins never load pictures from a
///   platform themselves, the app fetches them (`find_image`, `plugin_fetch`) after checking its hosts.
/// - `font-src data: <own files>`: a plugin's own fonts, should it ever draw text on a canvas.
/// - `worker-src blob:`: a plugin may do its heavy work in a worker made from a blob (allowed before
///   this policy was written out, so kept).
/// - `connect-src 'none'`: no fetch, XHR or sockets from the frame; a plugin's network goes through
///   `ms.net.fetch`, which the app checks against the hosts granted to it. The SDK fetches nothing.
/// - `frame-src 'none'`, `object-src 'none'`: no frames or plugins inside the frame.
/// - `base-uri 'none'`, `form-action 'none'`: no re-basing of the relative `__sdk.js` and entry
///   script, and no form can send anything anywhere.
pub fn frame_csp(id: &str) -> String {
    let own = format!("msplugin://localhost/{id}/ http://msplugin.localhost/{id}/");
    format!("default-src 'none'; script-src {own}; style-src 'unsafe-inline' {own}; img-src data: blob: {own}; font-src data: {own}; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
}

pub fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        _ => "application/octet-stream",
    }
}

/// What the msplugin protocol answers: the bytes, their content type, and the plugin's frame policy.
pub struct Served {
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub csp: String,
}

/// Resolve `/<id>/<path>` to what is served. `None` = not found.
pub fn serve(reg: &Registry, url_path: &str) -> Option<Served> {
    let decoded = percent_encoding::percent_decode_str(url_path).decode_utf8().ok()?;
    let trimmed = decoded.trim_start_matches('/');
    let (id, rest) = trimmed.split_once('/')?;
    let root = reg.root_of(id)?;
    let served = |body: Vec<u8>, content_type: &'static str| Some(Served { body, content_type, csp: frame_csp(id) });
    match rest {
        "__frame.html" => {
            let m = Registry::read_manifest(&root).ok()?;
            served(FRAME_HTML.replace("{{ENTRY}}", &m.entry).replace("{{ID}}", &m.id).into_bytes(), "text/html; charset=utf-8")
        }
        "__sdk.js" => served(SDK_JS.as_bytes().to_vec(), "text/javascript; charset=utf-8"),
        _ if safe_rel(rest) => {
            let p = root.join(rest);
            let canon_root = root.canonicalize().ok()?;
            let canon = p.canonicalize().ok()?;
            if !canon.starts_with(&canon_root) || !canon.is_file() {
                return None;
            }
            served(fs::read(&canon).ok()?, mime_for(rest))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-plugins-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn manifest(id: &str, version: &str, perms: &[&str]) -> Manifest {
        Manifest {
            id: id.into(),
            name: "Test".into(),
            version: version.into(),
            description: String::new(),
            author: String::new(),
            homepage: None,
            entry: "index.js".into(),
            permissions: perms.iter().map(|s| s.to_string()).collect(),
            settings: vec![],
            min_app_version: None,
            models: Vec::new(),
            engine: None,
            own_models: Vec::new(),
            icon: None,
        }
    }

    fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opt: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            for (name, data) in files {
                z.start_file(*name, opt).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn validates_manifests() {
        assert!(validate(&manifest("page-reader", "1.2.3", &["media:read", "network:api.example.com", "network:*.example.org"])).is_ok());
        assert!(validate(&manifest("Bad_Id", "1.0.0", &[])).is_err());
        assert!(validate(&manifest("ok", "one", &[])).is_err());
        assert!(validate(&manifest("ok", "1.0.0", &["filesystem"])).is_err());
        assert!(validate(&manifest("ok", "1.0.0", &["network:localhost"])).is_err());
        let mut m = manifest("ok", "1.0.0", &[]);
        m.entry = "../evil.js".into();
        assert!(validate(&m).is_err());
        m.entry = "src/main.js".into();
        assert!(validate(&m).is_ok());
        m.min_app_version = Some("99.0.0".into());
        assert!(validate(&m).unwrap_err().contains("needs Quire"));
    }

    #[test]
    fn validates_a_pipeline_and_its_own_models() {
        let mut m = manifest("page-cleaner", "2.0.0", &["media:read", "engine"]);
        m.engine = Some("engine.wasm".into());
        assert!(validate(&m).is_ok());
        for bad in ["../engine.wasm", "/abs/engine.wasm", "engine.js"] {
            m.engine = Some(bad.into());
            assert!(validate(&m).unwrap_err().contains(".wasm"), "{bad}");
        }
        m.engine = Some("engine.wasm".into());
        let file = serde_json::json!({ "repository": "", "revision": "", "name": "seg.pt", "size": 1 });
        m.own_models = vec![serde_json::json!({ "id": "my-model", "name": "Spot finder", "files": [file] })];
        assert!(validate(&m).unwrap_err().contains("named in models"), "an own model must be named in models");
        m.models = vec!["my-model".into()];
        assert!(validate(&m).is_ok());
        for bad in [
            serde_json::json!({ "id": "My-Model", "name": "x", "files": [file] }),
            serde_json::json!({ "id": "my-model", "name": " ", "files": [file] }),
            serde_json::json!({ "id": "my-model", "name": "x", "files": [] }),
            serde_json::json!({ "id": "my-model", "name": "x", "files": [{ "name": "../seg.pt" }] }),
        ] {
            m.own_models = vec![bad.clone()];
            assert!(validate(&m).is_err(), "{bad}");
        }
        m.own_models = vec![serde_json::json!({ "id": "my-model", "name": "x", "files": [file] }); 11];
        assert!(validate(&m).unwrap_err().contains("at most 10"));
    }

    #[test]
    fn network_permission_matching() {
        let g = vec!["network:api.example.com".to_string(), "network:*.example.net".to_string()];
        assert!(url_allowed(&g, "https://api.example.com/v1/pages").is_ok());
        assert!(url_allowed(&g, "https://api.example.net/v2/read").is_ok());
        assert!(url_allowed(&g, "https://example.net/").is_ok());
        assert!(url_allowed(&g, "https://evil.com/?api.example.com").is_err());
        assert!(url_allowed(&g, "https://api.example.com.evil.com/").is_err());
        assert!(url_allowed(&g, "http://api.example.com/").is_err(), "https only");
        assert!(url_allowed(&[], "https://api.example.com/").is_err());
    }

    #[test]
    fn find_permissions_and_sign_in_hosts() {
        assert!(validate(&manifest("example-find", "0.1.0", &["find", "library:storage", "login:login.example.org", "network:*.img.example.org"])).is_ok());
        assert!(validate(&manifest("bad", "0.1.0", &["login:localhost"])).unwrap_err().contains("invalid host"));
        let g = vec!["login:login.example.org".to_string(), "network:i.img.example.org".to_string()];
        assert!(login_allowed(&g, "https://login.example.org/sign-in?code_challenge=x").is_ok());
        assert!(login_allowed(&g, "http://login.example.org/sign-in").is_err(), "https only");
        assert!(login_allowed(&g, "https://i.img.example.org/").is_err(), "network: doesn't let a plugin open sign-in pages");
        assert!(url_allowed(&g, "https://login.example.org/v1/works").is_err(), "login: doesn't let a plugin fetch");
    }

    #[test]
    fn parses_github_links_and_paths() {
        let gh = |o: &str, r: &str, git_ref: Option<&str>, path: Option<&str>| Source::GitHub(GitHubRef { owner: o.into(), repo: r.into(), git_ref: git_ref.map(Into::into), path: path.map(Into::into) });
        assert_eq!(parse_source("https://github.com/ann/page-reader").unwrap(), gh("ann", "page-reader", None, None));
        assert_eq!(parse_source("  github.com/ann/page-reader.git/ ").unwrap(), gh("ann", "page-reader", None, None));
        assert_eq!(parse_source("git@github.com:ann/mt.git").unwrap(), gh("ann", "mt", None, None));
        assert_eq!(parse_source("https://github.com/ann/ms/tree/main/examples/plugins/page-reader").unwrap(), gh("ann", "ms", Some("main"), Some("examples/plugins/page-reader")));
        assert_eq!(parse_source("https://github.com/ann/ms/blob/v2.0/x/plugin.json").unwrap(), gh("ann", "ms", Some("v2.0"), Some("x")));
        assert_eq!(parse_source("https://github.com/ann/ms?tab=readme").unwrap(), gh("ann", "ms", None, None));
        assert!(parse_source("https://github.com/ann").is_err());
        assert!(parse_source("https://github.com/ann/ms/issues/3").is_err());
        assert!(parse_source("https://github.com/ann/ms/tree/main/../../etc").is_err());
        assert!(parse_source("https://gitlab.com/ann/ms").is_err());
        assert!(parse_source("my-plugin").is_err(), "relative paths are ambiguous");
        assert_eq!(parse_source("/Users/ann/p/plugin.json").unwrap(), Source::Local(PathBuf::from("/Users/ann/p")));
        assert_eq!(parse_source("'/Users/ann/My Plugin'").unwrap(), Source::Local(PathBuf::from("/Users/ann/My Plugin")));
        assert_eq!(parse_source("file:///Users/ann/My%20Plugin").unwrap(), Source::Local(PathBuf::from("/Users/ann/My Plugin")));
        assert!(matches!(parse_source("C:\\plugins\\mt").unwrap(), Source::Local(_)));
        let r = GitHubRef { owner: "ann".into(), repo: "ms".into(), git_ref: None, path: Some("p/x".into()) };
        assert_eq!(r.url(), "https://github.com/ann/ms/tree/HEAD/p/x");
        assert_eq!(parse_source(&r.url()).unwrap(), Source::GitHub(GitHubRef { git_ref: None, ..r }));
    }

    #[test]
    fn archive_extraction_is_safe_and_finds_the_plugin() {
        let base = tmp("zip");
        let good = serde_json::to_vec(&manifest("demo", "1.0.0", &[])).unwrap();
        let x = |z: &[u8], sub: Option<&str>| {
            let d = base.join(format!("x{}", hex::encode(rand_bytes(4))));
            fs::create_dir_all(&d).unwrap();
            extract_zip(z, &d, sub).map(|p| p.strip_prefix(&d).unwrap().to_path_buf())
        };
        // GitHub archives have one top-level folder.
        assert_eq!(x(&make_zip(&[("ann-demo-abc/plugin.json", &good), ("ann-demo-abc/index.js", b"")]), None).unwrap(), PathBuf::from("ann-demo-abc"));
        assert_eq!(x(&make_zip(&[("ann-ms-abc/README.md", b""), ("ann-ms-abc/p/demo/plugin.json", &good)]), Some("p/demo")).unwrap(), PathBuf::from("ann-ms-abc/p/demo"));
        assert!(x(&make_zip(&[("ann-ms-abc/p/demo/plugin.json", &good)]), None).unwrap_err().contains("tree/main/folder"));
        // Path traversal is refused before anything is written outside.
        assert!(x(&make_zip(&[("plugin.json", &good), ("../../escape.js", b"x")]), None).is_err());
        assert!(!base.join("escape.js").exists() && !base.parent().unwrap().join("escape.js").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_plugin_shows_its_own_logo_and_one_it_names_must_be_there() {
        let base = tmp("logo");
        let reg = Registry::new(base.join("reg"));
        let src = base.join("Logo Plugin");
        fs::create_dir_all(src.join("art")).unwrap();
        fs::write(src.join("index.js"), b"").unwrap();
        let mut m = manifest("logo", "1.0.0", &[]);
        let write = |m: &Manifest| fs::write(src.join("plugin.json"), serde_json::to_vec(m).unwrap()).unwrap();

        // Named but missing, the wrong kind, outside the plugin, too big: refused, saying why.
        m.icon = Some("art/logo.png".into());
        write(&m);
        assert!(reg.inspect(src.to_str().unwrap()).unwrap_err().contains("isn't in the plugin"));
        for bad in ["art/logo.exe", "../logo.png", "/logo.png"] {
            m.icon = Some(bad.into());
            assert!(validate(&m).is_err(), "{bad}");
        }
        m.icon = Some("art/logo.png".into());
        write(&m);
        fs::write(src.join("art/logo.png"), vec![0u8; MAX_ICON as usize + 1]).unwrap();
        assert!(reg.inspect(src.to_str().unwrap()).unwrap_err().contains("over 256 KB"));

        // There and small: listed with the plugin, ready to show.
        fs::write(src.join("art/logo.png"), b"\x89PNG").unwrap();
        reg.install(src.to_str().unwrap(), vec![], None).unwrap();
        let listed = reg.list().into_iter().find(|p| p.id == "logo").unwrap();
        assert_eq!(listed.icon.as_deref(), Some("data:image/png;base64,iVBORw=="));
        // A plugin naming none has none.
        m.icon = None;
        write(&m);
        assert!(reg.list().into_iter().find(|p| p.id == "logo").unwrap().icon.is_none());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn local_folder_is_used_in_place() {
        let base = tmp("local");
        let reg = Registry::new(base.join("reg"));
        let src = base.join("My Plugin");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("plugin.json"), serde_json::to_vec(&manifest("demo", "1.0.0", &["storage"])).unwrap()).unwrap();
        fs::write(src.join("index.js"), b"ms.log('v1')").unwrap();

        let seen = reg.inspect(src.to_str().unwrap()).unwrap();
        assert_eq!((seen.kind.as_str(), seen.manifest.id.as_str()), ("local", "demo"));
        let m = reg.install(&format!("{}/plugin.json", src.display()), vec!["storage".into(), "media:read".into()], None).unwrap();
        assert_eq!(m.id, "demo");
        let st = reg.load_state();
        assert_eq!(st["demo"].granted, vec!["storage".to_string()], "grants are limited to what the manifest asks");
        assert_eq!(st["demo"].linked.as_deref(), Some(src.to_str().unwrap()));
        assert!(!reg.installed_dir("demo").exists(), "nothing is copied");
        assert!(reg.check_update("demo").unwrap().is_none(), "local folders are always current");

        // Edits show up immediately.
        fs::write(src.join("index.js"), b"ms.log('v2')").unwrap();
        assert_eq!(serve(&reg, "/demo/index.js").unwrap().body, b"ms.log('v2')");
        let frame = serve(&reg, "/demo/__frame.html").unwrap();
        assert!(String::from_utf8(frame.body).unwrap().contains("index.js"));
        assert!(frame.content_type.starts_with("text/html"));
        // The frame's policy names this plugin's own files and nothing of the network.
        assert!(frame.csp.contains("script-src msplugin://localhost/demo/ http://msplugin.localhost/demo/;"), "{}", frame.csp);
        assert!(frame.csp.contains("connect-src 'none'"));
        assert!(!frame.csp.contains("'self'"), "a sandboxed frame has no origin for 'self' to name");
        assert!(serve(&reg, "/demo/..%2F..%2Fstate.json").is_none());
        assert!(serve(&reg, "/nope/index.js").is_none());

        reg.storage_set("demo", "k", serde_json::json!({"a": 1})).unwrap();
        assert_eq!(reg.storage_get("demo")["k"]["a"], 1);
        reg.uninstall("demo", false).unwrap();
        assert!(src.join("index.js").is_file(), "uninstall leaves the user's folder alone");
        assert!(!reg.data_dir("demo").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sites_the_reader_allows_are_its_hosts_with_their_subdomains() {
        let base = tmp("sites");
        let reg = Registry::new(base.join("reg"));
        let src = base.join("Sites");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("plugin.json"), serde_json::to_vec(&manifest("demo", "1.0.0", &["find", "sites"])).unwrap()).unwrap();
        fs::write(src.join("index.js"), b"").unwrap();
        reg.install(&format!("{}/plugin.json", src.display()), vec!["find".into(), "sites".into()], None).unwrap();
        assert!(set_sites("demo", vec!["*.example.org".into()]).is_err(), "a domain, not a pattern");
        assert!(set_sites("demo", vec!["not a host".into()]).is_err());
        assert_eq!(set_sites("demo", vec![" Example.ORG ".into(), "example.org".into(), "gallery.example.net".into()]).unwrap(), vec!["example.org".to_string(), "gallery.example.net".to_string()]);
        assert!(!fs::read_to_string(base.join("reg").join("state.json")).unwrap().contains("example.org"), "not written on this computer");
        let granted = reg.effective_permissions("demo");
        assert!(url_allowed(&granted, "https://i3.example.org/1/2.jpg").is_ok(), "its image hosts too");
        assert!(login_allowed(&granted, "https://example.org/").is_ok());
        assert!(url_allowed(&granted, "https://example.com/").is_err());
        // Without `sites` granted, the sites give nothing.
        reg.set_state("demo", None, None, Some(vec!["find".into()])).unwrap();
        assert!(url_allowed(&reg.effective_permissions("demo"), "https://example.org/").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    /// A tiny stand-in for api.github.com and raw.githubusercontent.com.
    fn fake_github(routes: std::sync::Arc<std::sync::Mutex<BTreeMap<String, Vec<u8>>>>) -> String {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                if r.read_line(&mut line).is_err() {
                    continue;
                }
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = routes.lock().unwrap().get(&path).cloned();
                match body {
                    Some(body) => {
                        let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = s.write_all(&body);
                    }
                    None => {
                        let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn installs_from_github_and_updates_from_the_same_repository() {
        let base = tmp("github");
        let routes = std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::new()));
        let host = fake_github(routes.clone());
        let mut reg = Registry::new(base.join("reg"));
        reg.gh = GitHubHosts { api: host.clone(), raw: format!("{host}/raw") };

        let c1 = "a".repeat(40);
        let c2 = "b".repeat(40);
        let c3 = "c".repeat(40);
        let m1 = serde_json::to_vec(&manifest("upd", "1.0.0", &["storage"])).unwrap();
        let m2 = serde_json::to_vec(&manifest("upd", "1.1.0", &["storage", "overlay"])).unwrap();
        let publish = |commit: &str, manifest: &[u8], js: &[u8]| {
            let mut r = routes.lock().unwrap();
            r.insert("/repos/ann/ms/commits/HEAD".into(), commit.as_bytes().to_vec());
            r.insert(format!("/raw/ann/ms/{commit}/plugins/upd/plugin.json"), manifest.to_vec());
            let top = format!("ann-ms-{}", &commit[..7]);
            r.insert(
                format!("/repos/ann/ms/zipball/{commit}"),
                make_zip(&[(&format!("{top}/README.md"), b"repo"), (&format!("{top}/plugins/upd/plugin.json"), manifest), (&format!("{top}/plugins/upd/index.js"), js)]),
            );
        };
        publish(&c1, &m1, b"v1");
        let link = "https://github.com/ann/ms/tree/HEAD/plugins/upd";

        let seen = reg.inspect(link).unwrap();
        assert_eq!((seen.kind.as_str(), seen.manifest.version.as_str()), ("github", "1.0.0"));
        assert_eq!(seen.location, link);
        reg.install(link, vec!["storage".into()], None).unwrap();
        assert_eq!(fs::read(reg.installed_dir("upd").join("index.js")).unwrap(), b"v1");
        assert!(!reg.installed_dir("upd").join("README.md").exists(), "only the plugin's folder is kept");
        assert_eq!(reg.load_state()["upd"].commit.as_deref(), Some(c1.as_str()));
        assert!(reg.check_update("upd").unwrap().is_none(), "same commit");

        // A new commit without a version bump is not an update.
        publish(&c3, &m1, b"v1-wip");
        assert!(reg.check_update("upd").unwrap().is_none());

        // A version bump is, with the new permission listed.
        publish(&c2, &m2, b"v2");
        let info = reg.check_update("upd").unwrap().expect("update available");
        assert_eq!((info.latest.as_str(), info.commit.as_str()), ("1.1.0", c2.as_str()));
        assert_eq!(info.new_permissions, vec!["overlay".to_string()]);

        // Declining new permissions still updates, without granting them.
        let m = reg.apply_update("upd", false).unwrap();
        assert_eq!(m.version, "1.1.0");
        assert_eq!(fs::read(reg.installed_dir("upd").join("index.js")).unwrap(), b"v2");
        assert_eq!(reg.effective_permissions("upd"), vec!["storage".to_string()]);
        assert!(reg.check_update("upd").unwrap().is_none(), "now current");

        // A missing repository gives a readable error and changes nothing.
        let err = reg.install("https://github.com/ann/missing", vec![], None).unwrap_err();
        assert!(err.contains("not found on GitHub"), "{err}");
        assert_eq!(fs::read(reg.installed_dir("upd").join("index.js")).unwrap(), b"v2");
        let _ = fs::remove_dir_all(&base);
    }
}
