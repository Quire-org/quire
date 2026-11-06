//! Quick unlock: the vault's data key is kept on this computer and handed out
//! only after a local authentication prompt. macOS: the key is a generic
//! password in the user's Keychain, and the prompt is Touch ID or the login
//! password through LocalAuthentication. Windows: a file only this user can
//! read in the app's data folder, behind Windows Hello (UserConsentVerifier).
//! Linux has no standard prompt, so there it is "unlock without passphrase on
//! this computer", gated by the login session alone.
//!
//! The passphrase and recovery code stay valid; this is a convenience slot
//! that lives only on this computer.

use std::path::{Path, PathBuf};

/// Where remembered keys live on Windows and Linux: the app's own data folder (`quick-unlock`), mode
/// 0600. On macOS this is only where earlier versions kept them: a key found here is moved into the
/// Keychain the next time it is used, and the file deleted.
fn store_dir() -> Result<PathBuf, String> {
    let dir = crate::data_dir().ok_or("the app's data folder isn't known yet")?.join("quick-unlock");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// A library's name in the store: a hash of its path, so the path itself shows nowhere (not in a file
/// name, not in Keychain Access).
fn root_name(root: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.to_string_lossy().hash(&mut h);
    format!("vault-{:016x}", h.finish())
}

fn key_file(root: &Path) -> Result<PathBuf, String> {
    Ok(store_dir()?.join(format!("{}.key", root_name(root))))
}

/// The key a file holds, hex-encoded as `remember_in_file` wrote it.
fn read_key_file(p: &Path) -> Result<[u8; 32], String> {
    let hex_key = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    decode_key(hex_key.trim().as_bytes())
}

fn decode_key(hex_key: &[u8]) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_key).map_err(|_| "stored key is corrupted".to_string())?;
    if bytes.len() != 32 {
        return Err("stored key is corrupted".into());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// The key into a file only this user can read.
#[cfg(not(target_os = "macos"))]
fn remember_in_file(root: &Path, key: &[u8; 32]) -> Result<(), String> {
    let p = key_file(root)?;
    std::fs::write(&p, hex::encode(key)).map_err(|e| format!("could not store the key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The key file gone, if there was one.
fn forget_file(root: &Path) -> Result<(), String> {
    let p = key_file(root)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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

#[cfg(not(target_os = "macos"))]
pub fn is_remembered(root: &Path) -> bool {
    key_file(root).map(|p| p.is_file()).unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn remember(root: &Path, key: &[u8; 32]) -> Result<(), String> {
    remember_in_file(root, key)
}

#[cfg(not(target_os = "macos"))]
pub fn forget(root: &Path) -> Result<(), String> {
    forget_file(root)
}

/// Prompt the user, then return the stored key.
#[cfg(not(target_os = "macos"))]
pub fn unlock(root: &Path, reason: &str) -> Result<[u8; 32], String> {
    let p = key_file(root)?;
    if !p.is_file() {
        return Err("this folder is not remembered on this computer".into());
    }
    authenticate(reason)?;
    read_key_file(&p)
}

/// The Keychain item a library's key is kept under: one service for the app, the account naming the
/// library as the key file did. The item is only read after the authentication prompt; whether it is
/// there is asked without reading it, which the Keychain allows without asking anything.
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Quire quick unlock";

/// The Keychain's "no such item" status.
#[cfg(target_os = "macos")]
const ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
fn in_service(service: &str, root: &Path) -> bool {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    // Attributes only: the secret itself is read in `unlock`, after the prompt.
    ItemSearchOptions::new().class(ItemClass::generic_password()).service(service).account(&root_name(root)).load_attributes(true).limit(Limit::Max(1)).search().is_ok_and(|found| !found.is_empty())
}

/// Under Quire's service, or Media Sorter's from before the rename (moved on the next unlock).
#[cfg(target_os = "macos")]
fn in_keychain(root: &Path) -> bool {
    in_service(KEYCHAIN_SERVICE, root) || in_service(crate::formerly::KEYCHAIN_SERVICE, root)
}

/// Remove a library's item from a service; one that isn't there is fine.
#[cfg(target_os = "macos")]
fn delete_item(service: &str, root: &Path) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(service, &root_name(root)) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(format!("could not remove the key from the Keychain: {e}")),
    }
}

#[cfg(target_os = "macos")]
pub fn is_remembered(root: &Path) -> bool {
    in_keychain(root) || key_file(root).map(|p| p.is_file()).unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn remember(root: &Path, key: &[u8; 32]) -> Result<(), String> {
    // Hex, as the file held it: what Keychain Access shows is a plain string.
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &root_name(root), hex::encode(key).as_bytes()).map_err(|e| format!("could not store the key in the Keychain: {e}"))?;
    // Any key from before (a file, or Media Sorter's Keychain item): Quire's item holds it now.
    if let Err(e) = delete_item(crate::formerly::KEYCHAIN_SERVICE, root) {
        eprintln!("[quick unlock] {e}");
    }
    forget_file(root)
}

#[cfg(target_os = "macos")]
pub fn forget(root: &Path) -> Result<(), String> {
    delete_item(KEYCHAIN_SERVICE, root)?;
    delete_item(crate::formerly::KEYCHAIN_SERVICE, root)?;
    forget_file(root)
}

/// Prompt the user, then return the stored key. A key an earlier version kept in a file, or under
/// Media Sorter's Keychain service, goes into Quire's Keychain item here and the old one is deleted,
/// so a library remembered before stays remembered.
#[cfg(target_os = "macos")]
pub fn unlock(root: &Path, reason: &str) -> Result<[u8; 32], String> {
    let old_file = key_file(root)?;
    if !in_keychain(root) && !old_file.is_file() {
        return Err("this folder is not remembered on this computer".into());
    }
    authenticate(reason)?;
    if old_file.is_file() {
        let key = read_key_file(&old_file)?;
        // The move into the Keychain failing is no reason to keep the user out: the file stays, and
        // the move is tried again next time.
        if let Err(e) = remember(root, &key) {
            eprintln!("[quick unlock] {e}");
        }
        return Ok(key);
    }
    if !in_service(KEYCHAIN_SERVICE, root) {
        let stored = security_framework::passwords::get_generic_password(crate::formerly::KEYCHAIN_SERVICE, &root_name(root)).map_err(|e| format!("could not read the key from the Keychain: {e}"))?;
        let key = decode_key(&stored)?;
        // As with the file: a move that fails is tried again next time.
        if let Err(e) = remember(root, &key) {
            eprintln!("[quick unlock] {e}");
        }
        return Ok(key);
    }
    let stored = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &root_name(root)).map_err(|e| format!("could not read the key from the Keychain: {e}"))?;
    decode_key(&stored)
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
    // SAFETY: LocalAuthentication's calls on an LAContext made here and kept alive for them; the reply
    // block is a heap block the system retains until it calls it, and it reads `error` only after
    // checking it isn't null (the framework passes a valid NSError or null).
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
    let avail = UserConsentVerifier::CheckAvailabilityAsync().map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
    if avail != UserConsentVerifierAvailability::Available {
        return Err("Windows Hello is not set up on this computer".into());
    }
    let res = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason)).map_err(|e| e.to_string())?.join().map_err(|e| e.to_string())?;
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
