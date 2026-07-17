//! Crypto utilities for shared secrets (KMS).
//!
//! Thin adapter over [`teamclaw_runtime_env::team_crypto`], which is the single
//! definition of the team secret wire format shared with the daemon. This layer
//! exists only to keep the `Result<_, String>` convention the Tauri command
//! surface expects; it must not add or alter any crypto behaviour.

pub use teamclaw_runtime_env::team_crypto::{EncryptedEnvelope, SecretEntry, SecretMeta};

use teamclaw_runtime_env::team_crypto;

/// Derive a 32-byte AES-256-GCM key from a hex-encoded 32-byte team secret
/// using HKDF-SHA256 (RFC 5869).
pub fn derive_key(team_secret: &str) -> Result<[u8; 32], String> {
    team_crypto::derive_key(team_secret).map_err(|e| format!("derive_key: {e}"))
}

/// Serialize `entry` to JSON and encrypt with AES-256-GCM using a random
/// 96-bit nonce.
pub fn encrypt_secret(
    entry: &SecretEntry,
    derived_key: &[u8; 32],
) -> Result<EncryptedEnvelope, String> {
    team_crypto::encrypt_secret(entry, derived_key).map_err(|e| format!("encrypt_secret: {e}"))
}

/// Decrypt an [`EncryptedEnvelope`] and deserialize the inner [`SecretEntry`].
pub fn decrypt_secret(
    envelope: &EncryptedEnvelope,
    derived_key: &[u8; 32],
) -> Result<SecretEntry, String> {
    team_crypto::decrypt_secret(envelope, derived_key).map_err(|e| format!("decrypt_secret: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crypto itself is covered in `teamclaw_runtime_env::team_crypto`.
    /// What matters here is only that this adapter preserves the error
    /// convention and does not leak the secret into the message.
    #[test]
    fn errors_are_strings_and_reveal_nothing() {
        let err = derive_key("deadbeef").unwrap_err();
        assert!(err.starts_with("derive_key: "));

        let key = derive_key(&"01".repeat(32)).unwrap();
        let wrong = derive_key(&"02".repeat(32)).unwrap();
        let entry = SecretEntry {
            key_id: "k".into(),
            key: "super-secret-value".into(),
            ..Default::default()
        };
        let envelope = encrypt_secret(&entry, &key).unwrap();
        let err = decrypt_secret(&envelope, &wrong).unwrap_err();
        assert!(err.starts_with("decrypt_secret: "));
        assert!(!err.contains("super-secret-value"));
    }
}
