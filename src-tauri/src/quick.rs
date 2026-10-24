//! Quick unlock: the vault's data key is kept in the OS credential store on
//! this machine and released only after a local authentication prompt.
//! macOS: Touch ID (or the login password) through LocalAuthentication, then
//! the Keychain. Windows: Windows Hello (UserConsentVerifier), then Credential
//! Manager. Linux: the Secret Service keyring, which the desktop unlocks with
//! the login session; no separate biometric prompt exists there.
//!
//! The passphrase and recovery code stay valid; this is a convenience slot
//! that lives only on this computer.

use std::path::Path;

const SERVICE: &str = "app.media-sorter.vault";

fn account_for(root: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.to_string_lossy().hash(&mut h);
    format!("vault-{:016x}", h.finish())
}

fn entry(root: &Path) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &account_for(root)).map_err(|e| e.to_string())
}

/// What the current platform can offer, for the UI.
pub fn method() -> &'static str {
    if cfg!(target_os = "macos") {
        "touchid"
    } else if cfg!(target_os = "windows") {
        "hello"
    } else {
        "keyring"
    }
}

pub fn is_remembered(root: &Path) -> bool {
    entry(root).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

pub fn remember(root: &Path, key: &[u8; 32]) -> Result<(), String> {
    entry(root)?.set_password(&hex::encode(key)).map_err(|e| format!("could not store the key: {e}"))
}

pub fn forget(root: &Path) -> Result<(), String> {
    match entry(root)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Confirm the user before storing a key (same prompt as unlocking).
pub fn authenticate_for_setup() -> Result<(), String> {
    authenticate("remember this vault on this computer")
}

/// Prompt the user, then return the stored key.
pub fn unlock(root: &Path, reason: &str) -> Result<[u8; 32], String> {
    authenticate(reason)?;
    let hex_key = entry(root)?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "this folder is not remembered on this computer".to_string(),
        e => e.to_string(),
    })?;
    let bytes = hex::decode(hex_key.trim()).map_err(|_| "stored key is corrupted".to_string())?;
    let mut key = [0u8; 32];
    if bytes.len() != 32 {
        return Err("stored key is corrupted".into());
    }
    key.copy_from_slice(&bytes);
    Ok(key)
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
    // The Secret Service keyring is the gate: it is locked until the desktop
    // session unlocks it, and may prompt for the keyring password itself.
    Ok(())
}
