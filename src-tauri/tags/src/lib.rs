//! What the local models know of each item (`tagindex`) and what each tag learned from it (`learn`),
//! and the faces in the pictures (`faceindex`).
//! A crate of its own so its number-heavy loops are optimised even in dev builds (see the app's
//! Cargo.toml): unoptimised, learning a tag took 20 times as long.

pub mod faceindex;
pub mod learn;
pub mod tagindex;
