//! The vault's cipher (XChaCha20-Poly1305) and passphrase hashing (Argon2id), in a crate of their
//! own so dev builds optimise them too (see the app's Cargo.toml): unoptimised, encrypting ran at
//! about 4 MB/s, and every picture in a vault is decrypted to be shown. The cipher's generic code is
//! compiled here, where it is optimised, not in the app that calls it.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

/// The cipher refused: a wrong key or changed data when decrypting, a nonce of the wrong length.
#[derive(Debug)]
pub struct Failed;

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the data did not encrypt or decrypt (a wrong key, or changed data)")
    }
}

/// XChaCha20-Poly1305 with one key: each message sealed under a 24-byte nonce, with data it is
/// bound to (`aad`, empty for none) that must be given again to open it.
pub struct Cipher(XChaCha20Poly1305);

impl Cipher {
    pub fn new(key: &[u8; 32]) -> Self {
        Cipher(XChaCha20Poly1305::new(key.into()))
    }

    pub fn encrypt(&self, nonce: &[u8], msg: &[u8], aad: &[u8]) -> Result<Vec<u8>, Failed> {
        self.0.encrypt(nonce_of(nonce)?, Payload { msg, aad }).map_err(|_| Failed)
    }

    pub fn decrypt(&self, nonce: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, Failed> {
        self.0.decrypt(nonce_of(nonce)?, Payload { msg: sealed, aad }).map_err(|_| Failed)
    }
}

fn nonce_of(n: &[u8]) -> Result<&XNonce, Failed> {
    if n.len() == 24 { Ok(XNonce::from_slice(n)) } else { Err(Failed) }
}

/// A 32-byte key from a passphrase: Argon2id with `m` KiB of memory, `t` passes and `p` lanes.
pub fn derive_key(passphrase: &[u8], salt: &[u8], m: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(passphrase, salt, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cipher's output for made-up inputs, as every build has written it. A build that writes
    /// anything else (a crate upgrade, the vector code turned on for a release) couldn't read the
    /// vaults already made, so the release runs this with its own build flags first.
    #[test]
    fn writes_what_every_earlier_build_wrote() {
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let nonce: [u8; 24] = core::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(1));
        let c = Cipher::new(&key);
        let mut fold: u64 = 1469598103934665603;
        for len in [65536usize, 65535, 65537, 1, 63, 64, 65, 255, 257, 1000] {
            let p: Vec<u8> = (0..len).map(|i| (i * 131 % 253) as u8).collect();
            let sealed = c.encrypt(&nonce, &p, &[]).unwrap();
            assert_eq!(c.decrypt(&nonce, &sealed, &[]).unwrap(), p);
            for b in sealed {
                fold = (fold ^ b as u64).wrapping_mul(1099511628211);
            }
        }
        assert_eq!(fold, 0x21db3f2fe1f9b620);
    }

    #[test]
    fn bound_data_and_nonces_must_match() {
        let c = Cipher::new(&[9; 32]);
        let sealed = c.encrypt(&[1; 24], b"index", b"index").unwrap();
        assert!(c.decrypt(&[1; 24], &sealed, b"library").is_err());
        assert!(c.decrypt(&[2; 24], &sealed, b"index").is_err());
        assert!(c.encrypt(&[1; 23], b"x", &[]).is_err(), "a short nonce is refused, not a panic");
        assert_eq!(derive_key(b"passphrase", &[0; 16], 64, 1, 1).unwrap(), derive_key(b"passphrase", &[0; 16], 64, 1, 1).unwrap());
    }
}
