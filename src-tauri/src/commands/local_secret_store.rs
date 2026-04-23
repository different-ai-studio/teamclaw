use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub(crate) const LOCAL_SECRETS_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub(crate) struct SecretStorePaths {
    pub(crate) base_dir: PathBuf,
    pub(crate) master_key_path: PathBuf,
    pub(crate) blob_path: PathBuf,
    pub(crate) meta_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SecretStoreMeta {
    pub(crate) version: u32,
    pub(crate) algorithm: String,
    pub(crate) migrated_from_keychain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedBlobFile {
    nonce_b64: String,
    ciphertext_b64: String,
}

impl SecretStorePaths {
    pub(crate) fn for_home_dir() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
        Ok(Self::for_base_dir(
            home.join(concat!(".", env!("APP_SHORT_NAME")))
                .join("secrets"),
        ))
    }

    pub(crate) fn for_base_dir(base_dir: PathBuf) -> Self {
        Self {
            master_key_path: base_dir.join("master.key"),
            blob_path: base_dir.join("personal-secrets.json.enc"),
            meta_path: base_dir.join("meta.json"),
            base_dir,
        }
    }
}

fn ensure_base_dir(paths: &SecretStorePaths) -> Result<(), String> {
    std::fs::create_dir_all(&paths.base_dir)
        .map_err(|e| format!("Failed to create secrets dir: {}", e))
}

fn load_or_create_master_key(paths: &SecretStorePaths) -> Result<[u8; 32], String> {
    ensure_base_dir(paths)?;
    if paths.master_key_path.exists() {
        let raw = std::fs::read(&paths.master_key_path)
            .map_err(|e| format!("Failed to read master key: {}", e))?;
        return raw
            .try_into()
            .map_err(|_| "Invalid master key length".to_string());
    }

    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    std::fs::write(&paths.master_key_path, key)
        .map_err(|e| format!("Failed to write master key: {}", e))?;
    Ok(key)
}

fn load_existing_master_key(paths: &SecretStorePaths) -> Result<[u8; 32], String> {
    let raw = std::fs::read(&paths.master_key_path)
        .map_err(|_| "Missing master key for existing encrypted secret store".to_string())?;
    raw.try_into()
        .map_err(|_| "Invalid master key length".to_string())
}

pub(crate) fn write_secret_blob(
    paths: &SecretStorePaths,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    ensure_base_dir(paths)?;
    let key = load_or_create_master_key(paths)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init failed: {}", e))?;
    let plaintext =
        serde_json::to_vec(map).map_err(|e| format!("Failed to serialize secret blob: {}", e))?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Failed to encrypt secret blob: {}", e))?;

    let file = EncryptedBlobFile {
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(ciphertext),
    };

    let tmp_path = paths.blob_path.with_extension("tmp");
    std::fs::write(
        &tmp_path,
        serde_json::to_vec_pretty(&file)
            .map_err(|e| format!("Failed to encode blob file: {}", e))?,
    )
    .map_err(|e| format!("Failed to write temp blob file: {}", e))?;
    std::fs::rename(&tmp_path, &paths.blob_path)
        .map_err(|e| format!("Failed to atomically replace blob file: {}", e))?;

    write_meta(
        paths,
        SecretStoreMeta {
            version: LOCAL_SECRETS_VERSION,
            algorithm: "aes-256-gcm".to_string(),
            migrated_from_keychain: read_meta(paths)
                .ok()
                .map(|m| m.migrated_from_keychain)
                .unwrap_or(false),
        },
    )?;

    Ok(())
}

pub(crate) fn read_secret_blob(
    paths: &SecretStorePaths,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !paths.blob_path.exists() {
        return Ok(serde_json::Map::new());
    }

    let key = load_existing_master_key(paths)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init failed: {}", e))?;
    let file: EncryptedBlobFile = serde_json::from_slice(
        &std::fs::read(&paths.blob_path).map_err(|e| format!("Failed to read blob file: {}", e))?,
    )
    .map_err(|e| format!("Failed to parse blob file: {}", e))?;

    let nonce_bytes = B64
        .decode(file.nonce_b64)
        .map_err(|e| format!("Failed to decode blob nonce: {}", e))?;
    if nonce_bytes.len() != 12 {
        return Err(format!(
            "Failed to decrypt secret blob: invalid nonce length {}",
            nonce_bytes.len()
        ));
    }
    let ciphertext = B64
        .decode(file.ciphertext_b64)
        .map_err(|e| format!("Failed to decode blob ciphertext: {}", e))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| "Failed to decrypt secret blob (authentication failed)".to_string())?;

    let value: serde_json::Value = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("Failed to parse secret blob JSON: {}", e))?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err("Secret blob JSON must be an object".to_string()),
    }
}

pub(crate) fn write_meta(paths: &SecretStorePaths, meta: SecretStoreMeta) -> Result<(), String> {
    ensure_base_dir(paths)?;
    std::fs::write(
        &paths.meta_path,
        serde_json::to_vec_pretty(&meta).map_err(|e| format!("Failed to encode meta: {}", e))?,
    )
    .map_err(|e| format!("Failed to write meta file: {}", e))
}

pub(crate) fn read_meta(paths: &SecretStorePaths) -> Result<SecretStoreMeta, String> {
    serde_json::from_slice(
        &std::fs::read(&paths.meta_path).map_err(|e| format!("Failed to read meta file: {}", e))?,
    )
    .map_err(|e| format!("Failed to parse meta file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trip_encrypts_and_decrypts_blob() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let mut map = serde_json::Map::new();
        map.insert("OPENAI_API_KEY".into(), serde_json::Value::String("sk-test".into()));

        write_secret_blob(&paths, &map).unwrap();
        let loaded = read_secret_blob(&paths).unwrap();

        assert_eq!(
            loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("sk-test")
        );
    }

    #[test]
    fn tampered_blob_fails_to_decrypt() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let mut map = serde_json::Map::new();
        map.insert("A".into(), serde_json::Value::String("B".into()));

        write_secret_blob(&paths, &map).unwrap();
        let raw = std::fs::read(&paths.blob_path).unwrap();
        let mut file: EncryptedBlobFile = serde_json::from_slice(&raw).unwrap();
        let mut ciphertext = B64.decode(file.ciphertext_b64).unwrap();
        ciphertext[0] ^= 0x01;
        file.ciphertext_b64 = B64.encode(ciphertext);
        std::fs::write(&paths.blob_path, serde_json::to_vec(&file).unwrap()).unwrap();

        let err = read_secret_blob(&paths).unwrap_err();
        assert!(err.contains("decrypt") || err.contains("authentication"));
    }

    #[test]
    fn missing_master_key_with_present_blob_fails() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let mut map = serde_json::Map::new();
        map.insert("A".into(), serde_json::Value::String("B".into()));

        write_secret_blob(&paths, &map).unwrap();
        std::fs::remove_file(&paths.master_key_path).unwrap();

        let err = read_secret_blob(&paths).unwrap_err();
        assert!(err.contains("master key"));
    }
}
