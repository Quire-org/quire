//! Quick unlock: the vault's data key is kept in a file only this user can
//! read, inside the app's data folder, and handed out only after a local
//! authentication prompt. macOS: Touch ID or the login password through
//! LocalAuthentication. Windows: Windows Hello (UserConsentVerifier). Linux
//! has no standard prompt, so there it is "unlock without passphrase on this
//! computer", gated by the login session alone.
//!
//! The passphrase and recovery code stay valid; this is a convenience slot
//! that lives only on this computer.

use std::path::{Path, PathBuf};

/// Where remembered keys live: the app's own data folder, mode 0600. The
/// Keychain was tried first, but its trust is bound to the exact binary and
/// unsigned builds trigger an "allow access" dialog that can hide behind the
/// window and look like a hang. A signed release build could move this to a
/// Secure Enclave-bound Keychain item later.
fn store_dir() -> Result<PathBuf, String> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    }
    .ok_or("no home directory")?;
    let dir = base.join("app.media-sorter").join("quick-unlock");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn key_file(root: &Path) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.to_string_lossy().hash(&mut h);
    Ok(store_dir()?.join(format!("vault-{:016x}.key", h.finish())))
}

/// What the current platform can offer, for the UI.
pub fn method() -> &'static str {
    if cfg!(target_os = "macos") {
        "touchid"
    } else if cfg!(target_os = "windows") {
        "hello"
    } else {
        "none"
    }
}

pub fn is_remembered(root: &Path) -> bool {
    key_file(root).map(|p| p.is_file()).unwrap_or(false)
}

pub fn remember(root: &Path, key: &[u8; 32]) -> Result<(), String> {
    let p = key_file(root)?;
    std::fs::write(&p, hex::encode(key)).map_err(|e| format!("could not store the key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn forget(root: &Path) -> Result<(), String> {
    let p = key_file(root)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Prompt the user, then return the stored key.
pub fn unlock(root: &Path, reason: &str) -> Result<[u8; 32], String> {
    let p = key_file(root)?;
    if !p.is_file() {
        return Err("this folder is not remembered on this computer".into());
    }
    authenticate(reason)?;
    let hex_key = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let bytes = hex::decode(hex_key.trim()).map_err(|_| "stored key is corrupted".to_string())?;
    if bytes.len() != 32 {
        return Err("stored key is corrupted".into());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Confirm the user before storing a key (same prompt as unlocking).
pub fn authenticate_for_setup() -> Result<(), String> {
    authenticate("remember this vault on this computer")
}


#[cfg(target_os = "macos")]
fn authenticate(reason: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc::channel;

    let (tx, rx) = channel::<Result<(), String>>();
    unsafe {
        let ctx = LAContext::new();
        ctx.setLocalizedCancelTitle(Some(&NSString::from_str("Use passphrase")));
        // Biometrics or the account password: the system picks the available one.
        let policy = LAPolicy::DeviceOwnerAuthentication;
        if let Err(e) = ctx.canEvaluatePolicy_error(policy) {
            return Err(format!("this Mac cannot authenticate the user: {}", e.localizedDescription()));
        }
        let block = RcBlock::new(move |ok: objc2::runtime::Bool, error: *mut NSError| {
            let res = if ok.as_bool() {
                Ok(())
            } else if error.is_null() {
                Err("authentication failed".to_string())
            } else {
                Err((*error).localizedDescription().to_string())
            };
            let _ = tx.send(res);
        });
        ctx.evaluatePolicy_localizedReason_reply(policy, &NSString::from_str(reason), &block);
    }
    rx.recv_timeout(std::time::Duration::from_secs(120)).map_err(|_| "authentication timed out".to_string())?
}

#[cfg(target_os = "windows")]
fn authenticate(reason: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
    let avail = UserConsentVerifier::CheckAvailabilityAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    if avail != UserConsentVerifierAvailability::Available {
        return Err("Windows Hello is not set up on this computer".into());
    }
    let res = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason)).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    if res == UserConsentVerificationResult::Verified {
        Ok(())
    } else {
        Err("Windows Hello did not verify".into())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn authenticate(_reason: &str) -> Result<(), String> {
    // No portable local-authentication API on Linux desktops; the login session is the gate.
    Ok(())
}
