//! Signing in to GitHub, so a plugin in a private repository can be installed and updated. GitHub's
//! device flow: the app shows a short code, the user approves it on github.com, and the app is
//! told. The sign-in is read-only and only reaches the repositories the user chose for the GitHub App.
//! Kept in the Keychain on Apple's systems (on iOS for this device alone), elsewhere in a file only this user can read.

use serde::{Deserialize, Serialize};

/// The GitHub App Quire signs in with (its client ID, which isn't a secret).
const CLIENT_ID: &str = "Iv23liMXz4pdUWz35abv";

/// What the sign-in is kept as.
#[derive(Serialize, Deserialize)]
struct Kept {
    token: String,
    login: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub login: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    #[serde(alias = "user_code")]
    pub user_code: String,
    #[serde(alias = "verification_uri")]
    pub verification_uri: String,
    #[serde(alias = "device_code")]
    pub device_code: String,
    /// Seconds to wait between asking whether it was approved.
    pub interval: u64,
    #[serde(alias = "expires_in")]
    pub expires_in: u64,
}

/// How the sign-in stands, when asked.
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Checked {
    Waiting,
    /// Asked too soon: wait longer between asking.
    Slower,
    Done,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder().user_agent(concat!("Quire/", env!("CARGO_PKG_VERSION"))).timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())
}

pub fn status() -> Status {
    Status { login: read().map(|k| k.login) }
}

/// The sign-in's token, when there is one.
pub fn token() -> Option<String> {
    read().map(|k| k.token)
}

pub fn start() -> Result<Started, String> {
    let resp = client()?.post("https://github.com/login/device/code").header("Accept", "application/json").form(&[("client_id", CLIENT_ID)]).send().map_err(|e| format!("could not reach GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub answered HTTP {}", resp.status().as_u16()));
    }
    resp.json().map_err(|e| format!("GitHub's answer: {e}"))
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct User {
    login: String,
}

pub fn check(device_code: &str) -> Result<Checked, String> {
    let http = client()?;
    let answer: TokenAnswer = http
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")])
        .send()
        .map_err(|e| format!("could not reach GitHub: {e}"))?
        .json()
        .map_err(|e| format!("GitHub's answer: {e}"))?;
    match (answer.access_token, answer.error.as_deref()) {
        (Some(token), _) => {
            let user: User = http.get("https://api.github.com/user").header("Accept", "application/vnd.github+json").bearer_auth(&token).send().map_err(|e| format!("could not reach GitHub: {e}"))?.json().map_err(|e| format!("GitHub's answer: {e}"))?;
            write(&Kept { token, login: user.login })?;
            Ok(Checked::Done)
        }
        (None, Some("authorization_pending")) => Ok(Checked::Waiting),
        (None, Some("slow_down")) => Ok(Checked::Slower),
        (None, Some("expired_token")) => Err("the code ran out before it was approved: start again".into()),
        (None, Some("access_denied")) => Err("the sign-in was turned down on GitHub".into()),
        (None, other) => Err(format!("GitHub refused the sign-in: {}", other.unwrap_or("no reason given"))),
    }
}

/// A repository a plugin could be added from.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    #[serde(alias = "full_name")]
    pub full_name: String,
    pub private: bool,
    pub description: Option<String>,
    #[serde(alias = "html_url")]
    pub html_url: String,
}

#[derive(Deserialize)]
struct Installations {
    installations: Vec<Installation>,
}

#[derive(Deserialize)]
struct Installation {
    id: u64,
}

#[derive(Deserialize)]
struct InstalledRepos {
    repositories: Vec<Repo>,
}

#[derive(Deserialize)]
struct Found {
    items: Vec<Repo>,
}

/// How many repositories GitHub gives to the page, and how many pages of an account's are read at most.
const PER_PAGE: usize = 100;
const MOST_PAGES: usize = 10;

fn ask<T: serde::de::DeserializeOwned>(http: &reqwest::blocking::Client, token: &str, path: &str, query: &[(&str, String)]) -> Result<T, String> {
    let resp = http.get(format!("https://api.github.com{path}")).header("Accept", "application/vnd.github+json").bearer_auth(token).query(query).send().map_err(|e| format!("could not reach GitHub: {e}"))?;
    match resp.status().as_u16() {
        401 => Err("GitHub no longer accepts this sign-in: sign out and sign in again".into()),
        403 | 429 => Err("GitHub asks to wait a moment before searching again".into()),
        code if !(200..300).contains(&code) => Err(format!("GitHub answered HTTP {code}")),
        _ => resp.json().map_err(|e| format!("GitHub's answer: {e}")),
    }
}

/// Every repository the sign-in reaches, private ones too: those of the accounts the GitHub App is installed on.
pub fn my_repos() -> Result<Vec<Repo>, String> {
    let token = token().ok_or("not signed in to GitHub")?;
    let http = client()?;
    let accounts: Installations = ask(&http, &token, "/user/installations", &[("per_page", PER_PAGE.to_string())])?;
    let mut all = Vec::new();
    for account in accounts.installations {
        for page in 1..=MOST_PAGES {
            let got: InstalledRepos = ask(&http, &token, &format!("/user/installations/{}/repositories", account.id), &[("per_page", PER_PAGE.to_string()), ("page", page.to_string())])?;
            let last = got.repositories.len() < PER_PAGE;
            all.extend(got.repositories);
            if last {
                break;
            }
        }
    }
    Ok(all)
}

/// GitHub's search by name: public repositories, and private ones the sign-in reaches.
pub fn search_repos(words: &str) -> Result<Vec<Repo>, String> {
    let token = token().ok_or("not signed in to GitHub")?;
    let found: Found = ask(&client()?, &token, "/search/repositories", &[("q", format!("{words} in:name")), ("per_page", "30".to_string())])?;
    Ok(found.items)
}

fn read() -> Option<Kept> {
    serde_json::from_slice(&load()?).ok()
}

fn write(kept: &Kept) -> Result<(), String> {
    save(&serde_json::to_vec(kept).map_err(|e| e.to_string())?)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const SERVICE: &str = "Quire GitHub sign-in";
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ACCOUNT: &str = "github";
/// The Keychain's "no such item" status.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ITEM_NOT_FOUND: i32 = -25300;

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn load() -> Option<Vec<u8>> {
    security_framework::passwords::get_generic_password(SERVICE, ACCOUNT).ok()
}

#[cfg(target_os = "macos")]
fn save(bytes: &[u8]) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, bytes).map_err(|e| format!("could not keep the sign-in in the Keychain: {e}"))
}

/// For this device alone: not in a backup, and only while it is unlocked.
#[cfg(target_os = "ios")]
fn save(bytes: &[u8]) -> Result<(), String> {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{PasswordOptions, set_generic_password_options};
    sign_out()?;
    let mut options = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
    options.set_access_control(SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly), 0).map_err(|e| e.to_string())?);
    set_generic_password_options(bytes, options).map_err(|e| format!("could not keep the sign-in in the Keychain: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn sign_out() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(format!("could not remove the sign-in from the Keychain: {e}")),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn file() -> Result<std::path::PathBuf, String> {
    Ok(crate::data_dir().ok_or("the app's data folder isn't known yet")?.join("github-sign-in.json"))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn load() -> Option<Vec<u8>> {
    std::fs::read(file().ok()?).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn save(bytes: &[u8]) -> Result<(), String> {
    let p = file()?;
    std::fs::write(&p, bytes).map_err(|e| format!("could not keep the sign-in: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn sign_out() -> Result<(), String> {
    match std::fs::remove_file(file()?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_found_repositories_and_hands_the_frontend_camel_case() {
        let found: Found = serde_json::from_str(r#"{"total_count":1,"incomplete_results":false,"items":[{"id":7,"full_name":"ann/ms","private":true,"description":null,"html_url":"https://github.com/ann/ms"}]}"#).unwrap();
        assert_eq!((found.items[0].full_name.as_str(), found.items[0].private, found.items[0].description.is_none()), ("ann/ms", true, true));
        let out = serde_json::to_value(&found.items[0]).unwrap();
        assert_eq!(out["fullName"], "ann/ms");
        assert_eq!(out["htmlUrl"], "https://github.com/ann/ms");
    }

    #[test]
    fn reads_github_s_answer_and_hands_the_frontend_camel_case() {
        let got: Started = serde_json::from_str(r#"{"device_code":"d","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#).unwrap();
        assert_eq!((got.user_code.as_str(), got.device_code.as_str(), got.interval, got.expires_in), ("WDJB-MJHT", "d", 5, 900));
        let out = serde_json::to_value(&got).unwrap();
        assert_eq!(out["userCode"], "WDJB-MJHT");
        assert_eq!(out["verificationUri"], "https://github.com/login/device");
    }
}
