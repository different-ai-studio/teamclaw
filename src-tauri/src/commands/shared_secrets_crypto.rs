//! Crypto utilities for shared secrets (KMS).
//!
//! Pure functions — no Tauri state or commands. Used by shared_secrets.rs and oss_sync.rs.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A plaintext secret entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    pub key_id: String,
    pub key: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub created_by: String,
    pub updated_by: String,
    pub updated_at: String,
}

/// Encrypted envelope stored on disk / OSS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    /// Format version (currently 1).
    pub v: u32,
    /// Base64-encoded 12-byte nonce.
    pub nonce: String,
    /// Base64-encoded AES-256-GCM ciphertext (includes 16-byte GCM tag).
    pub ciphertext: String,
}

/// Metadata-only view of a secret — no plaintext value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMeta {
    pub key_id: String,
    pub description: String,
    pub category: String,
    pub created_by: String,
    pub updated_by: String,
    pub updated_at: String,
}

impl From<&SecretEntry> for SecretMeta {
    fn from(entry: &SecretEntry) -> Self {
        SecretMeta {
            key_id: entry.key_id.clone(),
            description: entry.description.clone(),
            category: entry.category.clone(),
            created_by: entry.created_by.clone(),
            updated_by: entry.updated_by.clone(),
            updated_at: entry.updated_at.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// Derive a 32-byte AES-256-GCM key from a hex-encoded 32-byte team secret
/// using HKDF-SHA256 (RFC 5869).
///
/// - salt: `"teamclaw-secrets-v1"` (UTF-8 bytes)
/// - info: `"aes-256-gcm"` (UTF-8 bytes)
pub fn derive_key(team_secret: &str) -> Result<[u8; 32], String> {
    // Decode hex → 32 raw bytes (IKM).
    let ikm = hex::decode(team_secret)
        .map_err(|e| format!("derive_key: invalid hex team_secret: {e}"))?;
    if ikm.len() != 32 {
        return Err(format!(
            "derive_key: team_secret must be 32 bytes (64 hex chars), got {} bytes",
            ikm.len()
        ));
    }

    let salt = b"teamclaw-secrets-v1";
    let info = b"aes-256-gcm";

    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .map_err(|e| format!("derive_key: HKDF expand failed: {e}"))?;
    Ok(okm)
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/// Serialize `entry` to JSON and encrypt with AES-256-GCM using a random
/// 96-bit (12-byte) nonce. Returns an [`EncryptedEnvelope`].
pub fn encrypt_secret(
    entry: &SecretEntry,
    derived_key: &[u8; 32],
) -> Result<EncryptedEnvelope, String> {
    let plaintext =
        serde_json::to_vec(entry).map_err(|e| format!("encrypt_secret: serialize: {e}"))?;

    // Random 96-bit nonce.
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|e| format!("encrypt_secret: nonce generation: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(derived_key)
        .map_err(|e| format!("encrypt_secret: cipher init: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("encrypt_secret: AES-GCM encrypt: {e}"))?;

    Ok(EncryptedEnvelope {
        v: 1,
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

/// Decrypt an [`EncryptedEnvelope`] and deserialize the inner [`SecretEntry`].
pub fn decrypt_secret(
    envelope: &EncryptedEnvelope,
    derived_key: &[u8; 32],
) -> Result<SecretEntry, String> {
    let nonce_bytes = BASE64
        .decode(&envelope.nonce)
        .map_err(|e| format!("decrypt_secret: base64 nonce: {e}"))?;
    if nonce_bytes.len() != 12 {
        return Err(format!(
            "decrypt_secret: nonce must be 12 bytes, got {}",
            nonce_bytes.len()
        ));
    }

    let ciphertext = BASE64
        .decode(&envelope.ciphertext)
        .map_err(|e| format!("decrypt_secret: base64 ciphertext: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(derived_key)
        .map_err(|e| format!("decrypt_secret: cipher init: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("decrypt_secret: AES-GCM decrypt: {e}"))?;

    serde_json::from_slice(&plaintext).map_err(|e| format!("decrypt_secret: deserialize: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry() -> SecretEntry {
        SecretEntry {
            key_id: "api-key-prod".to_string(),
            key: "super-secret-value".to_string(),
            description: "Production API key".to_string(),
            category: "api".to_string(),
            updated_by: "alice".to_string(),
            updated_at: "2026-04-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_derive_key_roundtrip() {
        // 32 random bytes expressed as hex (64 chars).
        let hex_secret = "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe";
        let key = derive_key(hex_secret).expect("derive_key failed");
        assert_eq!(key.len(), 32);

        // Deterministic: same input → same output.
        let key2 = derive_key(hex_secret).expect("derive_key failed");
        assert_eq!(key, key2);
    }

    #[test]
    fn test_derive_key_rejects_short_hex() {
        let result = derive_key("deadbeef");
        assert!(result.is_err());
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let hex_secret = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        let key = derive_key(hex_secret).unwrap();
        let entry = sample_entry();

        let envelope = encrypt_secret(&entry, &key).expect("encrypt failed");
        assert_eq!(envelope.v, 1);
        assert!(!envelope.nonce.is_empty());
        assert!(!envelope.ciphertext.is_empty());

        let decrypted = decrypt_secret(&envelope, &key).expect("decrypt failed");
        assert_eq!(decrypted.key_id, entry.key_id);
        assert_eq!(decrypted.key, entry.key);
        assert_eq!(decrypted.description, entry.description);
    }

    #[test]
    fn test_decrypt_fails_with_wrong_key() {
        let hex_secret = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        let wrong_hex = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let key = derive_key(hex_secret).unwrap();
        let wrong_key = derive_key(wrong_hex).unwrap();

        let entry = sample_entry();
        let envelope = encrypt_secret(&entry, &key).unwrap();
        let result = decrypt_secret(&envelope, &wrong_key);
        assert!(result.is_err());
    }

    #[test]
    fn test_secret_meta_from_entry() {
        let entry = sample_entry();
        let meta = SecretMeta::from(&entry);
        assert_eq!(meta.key_id, entry.key_id);
        assert_eq!(meta.description, entry.description);
        assert_eq!(meta.category, entry.category);
        assert_eq!(meta.updated_by, entry.updated_by);
        assert_eq!(meta.updated_at, entry.updated_at);
    }
}
