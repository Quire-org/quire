//! The app on iOS: its library's folder, opened through the system's picker, and what happens as the
//! app leaves the screen (see `ios-bridge`).

use std::sync::atomic::{AtomicBool, Ordering};

use quire_ios_bridge::Bridge;
use tauri::{AppHandle, Emitter, Manager, Wry};

#[tauri::command]
pub async fn ios_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    crate::blocking(move || app.state::<Bridge<Wry>>().pick_folder()).await
}

#[tauri::command]
pub async fn ios_restore_folder(app: AppHandle) -> Result<Option<String>, String> {
    crate::blocking(move || app.state::<Bridge<Wry>>().restore_folder()).await
}

/// What is still held for the drive sent to it, and the drive let go of. Apps can't eject one on iOS.
#[tauri::command]
pub async fn ios_close_folder(app: AppHandle) -> Result<(), String> {
    crate::blocking(move || {
        // SAFETY: `sync` takes nothing and has no way to fail.
        unsafe { libc::sync() };
        app.state::<Bridge<Wry>>().close_folder()
    })
    .await
}

/// The screen kept on for a slideshow, with no finger on it to do that, or left to dim and lock again.
#[tauri::command]
pub async fn ios_keep_awake(app: AppHandle, on: bool) -> Result<(), String> {
    crate::blocking(move || app.state::<Bridge<Wry>>().keep_awake(on)).await
}

/// Other apps' audio taken for a video with sound, or given back with word that they can go on.
#[tauri::command]
pub async fn ios_hold_other_audio(app: AppHandle, hold: bool) -> Result<(), String> {
    crate::blocking(move || app.state::<Bridge<Wry>>().hold_other_audio(hold)).await
}

/// A site's browser check answered in a sheet of the app's own, for a plugin that may open the site.
/// Done, its browser view stays, hidden, as the site's session. None when it was cancelled.
#[tauri::command]
pub async fn plugin_check(app: AppHandle, id: String, url: String, name: String) -> Result<Option<crate::CheckPassed>, String> {
    let url = crate::plugins::login_allowed(&crate::registry(&app)?.effective_permissions(&id), &url)?;
    let site = crate::site_of(&url);
    crate::blocking(move || {
        let passed = app.state::<Bridge<Wry>>().check_site(&format!("{id}|{site}"), url.as_str(), &site, &name)?;
        Ok(passed.map(|(cookies, user_agent)| crate::CheckPassed { cookies, user_agent }))
    })
    .await
}

/// A page of a site fetched by its browser session, opened again from the cookies the plugin kept
/// if it is gone (they all go as the app leaves the screen). For a plugin that may open the site.
#[tauri::command]
pub async fn plugin_browse(app: AppHandle, id: String, url: String, cookies: Option<String>) -> Result<crate::Browsed, String> {
    let url = crate::plugins::login_allowed(&crate::registry(&app)?.effective_permissions(&id), &url)?;
    let site = crate::site_of(&url);
    crate::blocking(move || {
        let json = app.state::<Bridge<Wry>>().browse_site(&format!("{id}|{site}"), url.as_str(), &site, cookies.as_deref(), crate::BROWSE_BODY_CAP)?;
        crate::browsed_from(&json, &site)
    })
    .await
}

/// The app that is running, for what has only the backend to go on (the vault locking).
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Sites' browser sessions gone: with the vault locked, what they hold of a site is out of reach too.
pub fn drop_sites() {
    if let Some(app) = APP.get() {
        let _ = app.state::<Bridge<Wry>>().drop_sites();
    }
}

/// How long the frontend gets to write what it still holds, before the vault locks.
const FRONTEND_GETS: std::time::Duration = std::time::Duration::from_millis(1500);

/// The app left the screen and its vault isn't locked yet.
static LOCK_WAITING: AtomicBool = AtomicBool::new(false);

fn lock_if_waiting(app: &AppHandle) {
    if LOCK_WAITING.swap(false, Ordering::SeqCst) {
        crate::lock_vault_now(&app.state::<crate::VaultState>().share());
    }
}

/// Hear the app leaving the screen and coming back. The vault locks as it goes, and here alone: back
/// before that has happened it locks first, so nothing can lock it again once it has been opened.
pub fn watch(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        let on = app.clone();
        let watching = app.state::<Bridge<Wry>>().watch_app(move |state| match state {
            "background" => {
                LOCK_WAITING.store(true, Ordering::SeqCst);
                let _ = on.emit("app-left-screen", ());
                let late = on.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(FRONTEND_GETS);
                    lock_if_waiting(&late);
                });
            }
            "foreground" => {
                let back = on.clone();
                std::thread::spawn(move || {
                    lock_if_waiting(&back);
                    let _ = back.emit("app-back-on-screen", ());
                });
            }
            _ => {}
        });
        if let Err(e) = watching {
            eprintln!("[ios] can't hear the app leave the screen: {e}");
        }
    });
}
