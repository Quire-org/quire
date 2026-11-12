//! What only iOS can do for Quire, in Swift (`ios/Sources`): opening a folder the user picks (kept
//! open across launches by a bookmark), and telling the backend when the app leaves the screen.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use tauri::ipc::Channel;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

tauri::ios_plugin_binding!(init_plugin_quire_ios);

/// The bridge, kept by the app as managed state.
pub struct Bridge<R: Runtime>(PluginHandle<R>);

#[derive(Deserialize)]
struct Folder {
    path: Option<String>,
}

#[derive(Serialize)]
struct Watch {
    changed: Channel<String>,
}

#[derive(Serialize)]
struct KeepAwake {
    on: bool,
}

#[derive(Serialize)]
struct HoldOtherAudio {
    hold: bool,
}

#[derive(Serialize)]
struct CheckSite<'a> {
    key: &'a str,
    url: &'a str,
    site: &'a str,
    name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SiteChecked {
    cookies: Option<String>,
    user_agent: Option<String>,
}

#[derive(Serialize)]
struct BrowseSite<'a> {
    key: &'a str,
    url: &'a str,
    site: &'a str,
    cookies: Option<&'a str>,
    cap: usize,
}

#[derive(Deserialize)]
struct SiteBrowsed {
    json: String,
}

unsafe extern "C" {
    fn quire_pdf_page_count(bytes: *const u8, count: isize) -> isize;
    fn quire_pdf_page_size(bytes: *const u8, count: isize, number: isize, width: *mut f64, height: *mut f64) -> bool;
    fn quire_pdf_draw(bytes: *const u8, count: isize, number: isize, width: isize, height: isize, pixels: *mut u8) -> bool;
}

/// How many pages a PDF has; None when it can't be read.
pub fn pdf_page_count(bytes: &[u8]) -> Option<u32> {
    // SAFETY: the pointer and length are of a slice that outlives the call, which only reads it.
    let n = unsafe { quire_pdf_page_count(bytes.as_ptr(), bytes.len() as isize) };
    u32::try_from(n).ok()
}

/// A page (from 1) drawn with its longer side `side` pixels: its width, height and 4 bytes a pixel (the fourth unused).
pub fn pdf_draw(bytes: &[u8], page: u32, side: u32) -> Option<(u32, u32, Vec<u8>)> {
    let (mut shown_w, mut shown_h) = (0f64, 0f64);
    // SAFETY: the slice outlives the call, which only reads it and writes the two f64s it is pointed at.
    if !unsafe { quire_pdf_page_size(bytes.as_ptr(), bytes.len() as isize, page as isize, &mut shown_w, &mut shown_h) } || shown_w <= 0.0 || shown_h <= 0.0 {
        return None;
    }
    let scale = f64::from(side) / shown_w.max(shown_h);
    let (width, height) = (((shown_w * scale).round() as u32).max(1), ((shown_h * scale).round() as u32).max(1));
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    // SAFETY: `pixels` holds exactly width × height pixels of 4 bytes, which is what the call fills.
    unsafe { quire_pdf_draw(bytes.as_ptr(), bytes.len() as isize, page as isize, width as isize, height as isize, pixels.as_mut_ptr()) }.then_some((width, height, pixels))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("quire-ios")
        .setup(|app, api| {
            use tauri::Manager;
            app.manage(Bridge(api.register_ios_plugin(init_plugin_quire_ios)?));
            Ok(())
        })
        .build()
}

impl<R: Runtime> Bridge<R> {
    /// The system's folder picker. The folder picked stays open for this app, and is remembered.
    /// None when the picker was cancelled. Blocks until it is answered.
    pub fn pick_folder(&self) -> Result<Option<String>, String> {
        self.0.run_mobile_plugin::<Folder>("pickFolder", ()).map(|f| f.path).map_err(|e| e.to_string())
    }

    /// The folder picked last time, opened again, where it is now. None when there is none, or its
    /// drive isn't plugged in.
    pub fn restore_folder(&self) -> Result<Option<String>, String> {
        self.0.run_mobile_plugin::<Folder>("restoreFolder", ()).map(|f| f.path).map_err(|e| e.to_string())
    }

    /// The open folder let go of. It is still remembered, for the next launch.
    pub fn close_folder(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("closeFolder", ()).map(|_| ()).map_err(|e| e.to_string())
    }

    /// The screen kept from dimming and locking, or left to again.
    pub fn keep_awake(&self, on: bool) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("keepAwake", KeepAwake { on }).map(|_| ()).map_err(|e| e.to_string())
    }

    /// Other apps' audio taken for a video with sound, or given back with word that they can go on.
    pub fn hold_other_audio(&self, hold: bool) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("holdOtherAudio", HoldOtherAudio { hold }).map(|_| ()).map_err(|e| e.to_string())
    }

    /// A site's check, in a sheet over the app, for the reader to answer. Done, its browser view stays,
    /// hidden, as session `key`; the site's cookies and the browser's name come back. None when it was
    /// cancelled, or had no cookies to give. Blocks until it is answered.
    pub fn check_site(&self, key: &str, url: &str, site: &str, name: &str) -> Result<Option<(String, String)>, String> {
        let got = self.0.run_mobile_plugin::<SiteChecked>("checkSite", CheckSite { key, url, site, name }).map_err(|e| e.to_string())?;
        Ok(got.cookies.map(|c| (c, got.user_agent.unwrap_or_default())))
    }

    /// A page fetched by session `key`, opened again from `cookies` if it is gone: the JSON its script said.
    pub fn browse_site(&self, key: &str, url: &str, site: &str, cookies: Option<&str>, cap: usize) -> Result<String, String> {
        self.0.run_mobile_plugin::<SiteBrowsed>("browseSite", BrowseSite { key, url, site, cookies, cap }).map(|b| b.json).map_err(|e| e.to_string())
    }

    /// Every site's session gone, and any check still open.
    pub fn drop_sites(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("dropSites", ()).map(|_| ()).map_err(|e| e.to_string())
    }

    /// Calls `on` with "background" when the app has left the screen and "foreground" when it is back.
    pub fn watch_app(&self, on: impl Fn(&str) + Send + Sync + 'static) -> Result<(), String> {
        let changed = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                on(serde_json::from_str::<String>(&json).unwrap_or_default().as_str());
            }
            Ok(())
        });
        self.0.run_mobile_plugin::<serde_json::Value>("watchApp", Watch { changed }).map(|_| ()).map_err(|e| e.to_string())
    }
}
