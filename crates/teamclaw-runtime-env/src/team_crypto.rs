//! Canonical crypto for team shared secrets (`_secrets/*.enc.json`).
//!
//! Every producer and consumer of a team secret envelope goes through this
//! module: the desktop settings UI encrypts here, the daemon's runtime env
//! injection and the env catalog decrypt here, and `derive_key` additionally
//! backs OSS blob crypto. Previously each of those carried its own copy of the
//! same HKDF + AES-256-GCM code, which is a format contract three ways: a drift
//! in salt, envelope version, or `SecretEntry` shape does not fail to compile,
//! it fails at runtime as an undecryptable secret on someone else's machine.
//!
//! ## Wire format (v1)
//!
//! `_secrets/<key_id>.enc.json` holds a JSON [`EncryptedEnvelope`]. Its
//! `ciphertext` is AES-256-GCM over the JSON encoding of a [`SecretEntry`],
//! under a key HKDF-derived from the team secret. Both the envelope JSON and
//! the inner entry JSON are camelCase.
//!
//! Changing [`SALT`], [`INFO`], [`ENVELOPE_VERSION`], or the `SecretEntry`
//! field names breaks every secret already written by every client. Treat them
//! as frozen and add a new version instead.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

// ---------------------------------------------------------------------------
// Format constants — frozen
// ---------------------------------------------------------------------------

/// HKDF-SHA256 salt. Frozen: see module docs.
pub const SALT: &[u8] = b"teamclaw-secrets-v1";

/// HKDF-SHA256 info. Frozen: see module docs.
pub const INFO: &[u8] = b"aes-256-gcm";

/// The only envelope version this module reads or writes.
pub const ENVELOPE_VERSION: u32 = 1;

/// Raw team secret length in bytes (64 hex chars).
pub const TEAM_SECRET_BYTES: usize = 32;

/// AES-256-GCM nonce length in bytes.
pub const NONCE_BYTES: usize = 12;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum TeamCryptoError {
    #[error("team secret is not valid hex: {0}")]
    SecretNotHex(#[from] hex::FromHexError),

    #[error("team secret must be {TEAM_SECRET_BYTES} bytes ({} hex chars), got {got} bytes", TEAM_SECRET_BYTES * 2)]
    SecretWrongLength { got: usize },

    #[error("HKDF expand failed")]
    HkdfExpand,

    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u32),

    #[error("nonce must be {NONCE_BYTES} bytes, got {got}")]
    NonceWrongLength { got: usize },

    #[error("base64 decode failed: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("cipher init failed")]
    CipherInit,

    #[error("AES-GCM encrypt failed")]
    Encrypt,

    /// Deliberately opaque: a GCM tag mismatch means a wrong key or tampering,
    /// and distinguishing the two for a caller only helps an attacker.
    #[error("AES-GCM decrypt failed (wrong key or corrupt data)")]
    Decrypt,

    #[error("nonce generation failed: {0}")]
    Nonce(getrandom::Error),

    #[error("secret entry JSON: {0}")]
    Json(#[from] serde_json::Error),
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A plaintext secret entry — the JSON inside an [`EncryptedEnvelope`].
///
/// Only `key_id` is required. Every other field defaults, so an entry written
/// by an older or narrower client still round-trips: a consumer that only cares
/// about `key_id`/`key` must not drop the metadata fields when re-encrypting.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    pub key_id: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub updated_by: String,
    #[serde(default)]
    pub updated_at: String,
}

/// Encrypted envelope as stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    /// Format version — always [`ENVELOPE_VERSION`].
    pub v: u32,
    /// Base64-encoded 12-byte nonce.
    pub nonce: String,
    /// Base64-encoded AES-256-GCM ciphertext (includes the 16-byte GCM tag).
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
/// using HKDF-SHA256 (RFC 5869) with [`SALT`] and [`INFO`].
pub fn derive_key(team_secret: &str) -> Result<[u8; 32], TeamCryptoError> {
    let ikm = hex::decode(team_secret)?;
    if ikm.len() != TEAM_SECRET_BYTES {
        return Err(TeamCryptoError::SecretWrongLength { got: ikm.len() });
    }

    let hk = Hkdf::<Sha256>::new(Some(SALT), &ikm);
    let mut okm = [0u8; 32];
    hk.expand(INFO, &mut okm)
        .map_err(|_| TeamCryptoError::HkdfExpand)?;
    Ok(okm)
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/// Encrypt `entry` under a fresh random nonce.
pub fn encrypt_secret(
    entry: &SecretEntry,
    derived_key: &[u8; 32],
) -> Result<EncryptedEnvelope, TeamCryptoError> {
    let plaintext = serde_json::to_vec(entry)?;

    let mut nonce_bytes = [0u8; NONCE_BYTES];
    getrandom::getrandom(&mut nonce_bytes).map_err(TeamCryptoError::Nonce)?;

    let cipher = Aes256Gcm::new_from_slice(derived_key).map_err(|_| TeamCryptoError::CipherInit)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| TeamCryptoError::Encrypt)?;

    Ok(EncryptedEnvelope {
        v: ENVELOPE_VERSION,
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

/// Decrypt an [`EncryptedEnvelope`] back into its [`SecretEntry`].
pub fn decrypt_secret(
    envelope: &EncryptedEnvelope,
    derived_key: &[u8; 32],
) -> Result<SecretEntry, TeamCryptoError> {
    if envelope.v != ENVELOPE_VERSION {
        return Err(TeamCryptoError::UnsupportedVersion(envelope.v));
    }

    let nonce_bytes = BASE64.decode(&envelope.nonce)?;
    if nonce_bytes.len() != NONCE_BYTES {
        return Err(TeamCryptoError::NonceWrongLength {
            got: nonce_bytes.len(),
        });
    }
    let ciphertext = BASE64.decode(&envelope.ciphertext)?;

    let cipher = Aes256Gcm::new_from_slice(derived_key).map_err(|_| TeamCryptoError::CipherInit)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| TeamCryptoError::Decrypt)?;

    Ok(serde_json::from_slice(&plaintext)?)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

    fn sample_entry() -> SecretEntry {
        SecretEntry {
            key_id: "api-key-prod".to_string(),
            key: "super-secret-value".to_string(),
            description: "Production API key".to_string(),
            category: "api".to_string(),
            created_by: "alice".to_string(),
            updated_by: "alice".to_string(),
            updated_at: "2026-04-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn derive_key_is_deterministic() {
        let a = derive_key(SECRET).unwrap();
        let b = derive_key(SECRET).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    /// Pins the derived key to a literal. Any change to SALT, INFO, or the HKDF
    /// construction breaks this — which is the point: it would silently make
    /// every secret already on disk undecryptable.
    #[test]
    fn derive_key_matches_frozen_vector() {
        let key = derive_key(&"00".repeat(32)).unwrap();
        assert_eq!(
            hex::encode(key),
            "d87d5fd7361bbf204cb7dc5aa0f9e4641d279bded6773423a5b6f8ffeb8f1b0e",
            "HKDF output changed — every existing team secret would break"
        );
    }

    #[test]
    fn derive_key_rejects_wrong_length() {
        assert!(matches!(
            derive_key("deadbeef"),
            Err(TeamCryptoError::SecretWrongLength { got: 4 })
        ));
    }

    #[test]
    fn derive_key_rejects_non_hex() {
        assert!(matches!(
            derive_key(&"zz".repeat(32)),
            Err(TeamCryptoError::SecretNotHex(_))
        ));
    }

    #[test]
    fn encrypt_decrypt_roundtrip_preserves_every_field() {
        let key = derive_key(SECRET).unwrap();
        let entry = sample_entry();

        let envelope = encrypt_secret(&entry, &key).unwrap();
        assert_eq!(envelope.v, ENVELOPE_VERSION);

        let out = decrypt_secret(&envelope, &key).unwrap();
        assert_eq!(out.key_id, entry.key_id);
        assert_eq!(out.key, entry.key);
        assert_eq!(out.description, entry.description);
        assert_eq!(out.category, entry.category);
        assert_eq!(out.created_by, entry.created_by);
        assert_eq!(out.updated_by, entry.updated_by);
        assert_eq!(out.updated_at, entry.updated_at);
    }

    #[test]
    fn nonce_is_fresh_per_encryption() {
        let key = derive_key(SECRET).unwrap();
        let entry = sample_entry();
        let a = encrypt_secret(&entry, &key).unwrap();
        let b = encrypt_secret(&entry, &key).unwrap();
        assert_ne!(a.nonce, b.nonce, "GCM nonce reuse would be catastrophic");
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn decrypt_rejects_wrong_key() {
        let key = derive_key(SECRET).unwrap();
        let wrong = derive_key(&"ff".repeat(32)).unwrap();
        let envelope = encrypt_secret(&sample_entry(), &key).unwrap();
        assert!(matches!(
            decrypt_secret(&envelope, &wrong),
            Err(TeamCryptoError::Decrypt)
        ));
    }

    #[test]
    fn decrypt_rejects_tampered_ciphertext() {
        let key = derive_key(SECRET).unwrap();
        let mut envelope = encrypt_secret(&sample_entry(), &key).unwrap();
        let mut raw = BASE64.decode(&envelope.ciphertext).unwrap();
        raw[0] ^= 0xff;
        envelope.ciphertext = BASE64.encode(raw);
        assert!(matches!(
            decrypt_secret(&envelope, &key),
            Err(TeamCryptoError::Decrypt)
        ));
    }

    #[test]
    fn decrypt_rejects_unknown_version() {
        let key = derive_key(SECRET).unwrap();
        let mut envelope = encrypt_secret(&sample_entry(), &key).unwrap();
        envelope.v = 2;
        assert!(matches!(
            decrypt_secret(&envelope, &key),
            Err(TeamCryptoError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn decrypt_rejects_bad_nonce_length() {
        let key = derive_key(SECRET).unwrap();
        let mut envelope = encrypt_secret(&sample_entry(), &key).unwrap();
        envelope.nonce = BASE64.encode([0u8; 8]);
        assert!(matches!(
            decrypt_secret(&envelope, &key),
            Err(TeamCryptoError::NonceWrongLength { got: 8 })
        ));
    }

    /// The daemon historically modelled `SecretEntry` as `{keyId, key}` only.
    /// Entries written that way must still decrypt, with metadata defaulted
    /// rather than erroring.
    #[test]
    fn decrypts_narrow_two_field_entry() {
        let key = derive_key(SECRET).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = [7u8; NONCE_BYTES];
        let plaintext = br#"{"keyId":"legacy","key":"value"}"#;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        let envelope = EncryptedEnvelope {
            v: 1,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };

        let out = decrypt_secret(&envelope, &key).unwrap();
        assert_eq!(out.key_id, "legacy");
        assert_eq!(out.key, "value");
        assert_eq!(out.description, "");
    }

    /// The envelope and entry are both camelCase on the wire. A rename here
    /// would strand every file already written.
    #[test]
    fn wire_field_names_are_stable() {
        let json = serde_json::to_value(sample_entry()).unwrap();
        for field in [
            "keyId",
            "key",
            "description",
            "category",
            "createdBy",
            "updatedBy",
            "updatedAt",
        ] {
            assert!(json.get(field).is_some(), "SecretEntry lost field {field}");
        }

        let key = derive_key(SECRET).unwrap();
        let envelope =
            serde_json::to_value(encrypt_secret(&sample_entry(), &key).unwrap()).unwrap();
        for field in ["v", "nonce", "ciphertext"] {
            assert!(
                envelope.get(field).is_some(),
                "EncryptedEnvelope lost field {field}"
            );
        }
    }

    #[test]
    fn secret_meta_carries_no_plaintext_value() {
        let entry = sample_entry();
        let meta = SecretMeta::from(&entry);
        assert_eq!(meta.key_id, entry.key_id);
        assert_eq!(meta.updated_at, entry.updated_at);
        let json = serde_json::to_string(&meta).unwrap();
        assert!(
            !json.contains(&entry.key),
            "SecretMeta must never carry the secret value"
        );
    }
}
