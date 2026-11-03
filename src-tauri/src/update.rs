//! The app updating itself from its GitHub releases. The release workflow puts a small `latest.json`
//! beside each release: the version, its notes, and a download for each platform signed with the
//! release key. When asked, the app reads it, downloads the new version as an Activity job, and puts
//! it in place by restarting; the signature (bound to the version it was made for) is checked before
//! anything is replaced. Only a release build updates: a dev build, or one built outside the release
//! workflow, says why not.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The repository the release workflow built this from: GitHub Actions names it at build time.
const REPOSITORY: Option<&str> = option_env!("GITHUB_REPOSITORY");

/// The update found by the last check, and its download once made.
#[derive(Default)]
pub struct UpdateState(Mutex<Pending>);

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

/// This build, and whether it can update itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    version: String,
    /// Why this build can't update itself, when it can't.
    cannot: Option<String>,
}

/// A newer version, as its release describes it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    version: String,
    notes: Option<String>,
    /// When it was released, ms since epoch.
    date: Option<i64>,
    /// Downloaded already: it goes in place with the next restart.
    downloaded: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    done: u64,
    total: Option<u64>,
}

fn cannot() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        Some("This is a development build: updates come with the released app.")
    } else if REPOSITORY.is_none() {
        Some("This build was made outside the release workflow, so it doesn't know where its releases are.")
    } else {
        None
    }
}

fn lock(state: &UpdateState) -> std::sync::MutexGuard<'_, Pending> {
    state.0.lock().unwrap_or_else(|p| p.into_inner())
}

#[tauri::command]
pub fn app_build(app: AppHandle) -> Build {
    Build { version: app.package_info().version.to_string(), cannot: cannot().map(Into::into) }
}

/// Is a newer version out? Goes online once, to the repository's latest release.
#[tauri::command]
pub async fn app_update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<Found>, String> {
    if let Some(why) = cannot() {
        return Err(why.into());
    }
    let repo = REPOSITORY.unwrap_or_default();
    let url = tauri::Url::parse(&format!("https://github.com/{repo}/releases/latest/download/latest.json")).map_err(|e| e.to_string())?;
    let found = app.updater_builder().endpoints(vec![url]).and_then(|b| b.timeout(Duration::from_secs(30)).build()).map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let mut p = lock(&state);
    let Some(update) = found else {
        *p = Pending::default();
        return Ok(None);
    };
    // The same version found again keeps its download.
    let same = p.update.as_ref().is_some_and(|u| u.version == update.version);
    if !same {
        p.bytes = None;
    }
    let out = Found { version: update.version.clone(), notes: update.body.clone(), date: update.date.map(|d| d.unix_timestamp() * 1000), downloaded: same && p.bytes.is_some() };
    p.update = Some(update);
    Ok(Some(out))
}

/// Download the version found, as Activity job `job`. It can't pause (a download either runs or is
/// dropped); stopped, what came is let go.
#[tauri::command]
pub async fn app_update_download(state: State<'_, UpdateState>, job: Option<String>, on_progress: tauri::ipc::Channel<Progress>) -> Result<(), String> {
    let update = lock(&state).update.clone().ok_or("Check for updates first.")?;
    let bytes = crate::blocking(move || {
        let (_job, ctl) = crate::control(job.as_deref());
        let task = tauri::async_runtime::spawn(async move {
            let mut done = 0u64;
            update
                .download(
                    |chunk, total| {
                        done += chunk as u64;
                        let _ = on_progress.send(Progress { done, total });
                    },
                    || {},
                )
                .await
        });
        while !task.inner().is_finished() {
            if ctl.stopped() {
                task.abort();
                return Err("stopped".to_string());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        tauri::async_runtime::block_on(task).map_err(|e| e.to_string())?.map_err(|e| e.to_string())
    })
    .await?;
    lock(&state).bytes = Some(bytes);
    Ok(())
}

/// Put the downloaded version in place (its signature checked first) and restart into it. The app
/// asks only once nothing is running.
#[tauri::command]
pub async fn app_update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let (update, bytes) = {
        let p = lock(&state);
        (p.update.clone().ok_or("Check for updates first.")?, p.bytes.clone().ok_or("Download the update first.")?)
    };
    crate::blocking(move || update.install(&bytes).map_err(|e| e.to_string())).await?;
    app.request_restart();
    Ok(())
}
