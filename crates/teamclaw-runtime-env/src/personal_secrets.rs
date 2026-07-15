use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tracing::warn;

use crate::APP_SECRETS_DIR;

#[derive(Debug, Clone)]
struct SecretStorePaths {
    master_key_path: PathBuf,
    blob_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedBlobFile {
    nonce_b64: String,
    ciphertext_b64: String,
}

impl SecretStorePaths {
    fn for_home_dir() -> Option<Self> {
        let home = dirs::home_dir()?;
        Some(Self::for_base_dir(
            home.join(format!(".{}", APP_SECRETS_DIR)).join("secrets"),
        ))
    }

    fn for_base_dir(base_dir: PathBuf) -> Self {
        Self {
            master_key_path: base_dir.join("master.key"),
            blob_path: base_dir.join("personal-secrets.json.enc"),
        }
    }
}

fn load_master_key(paths: &SecretStorePaths) -> anyhow::Result<[u8; 32]> {
    let raw = std::fs::read(&paths.master_key_path)?;
    raw.try_into()
        .map_err(|_| anyhow::anyhow!("Invalid master key length"))
}

fn read_secret_blob(
    paths: &SecretStorePaths,
) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
    if !paths.blob_path.exists() {
        return Ok(serde_json::Map::new());
    }

    let key = load_master_key(paths)?;
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let file: EncryptedBlobFile = serde_json::from_slice(&std::fs::read(&paths.blob_path)?)?;

    let nonce_bytes = B64.decode(&file.nonce_b64)?;
    if nonce_bytes.len() != 12 {
        anyhow::bail!("Invalid nonce length {}", nonce_bytes.len());
    }
    let ciphertext = B64.decode(&file.ciphertext_b64)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("Failed to decrypt secret blob (authentication failed)"))?;

    let value: serde_json::Value = serde_json::from_slice(&plaintext)?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => anyhow::bail!("Secret blob JSON must be an object"),
    }
}

fn string_env_from_map(map: serde_json::Map<String, serde_json::Value>) -> HashMap<String, String> {
    map.into_iter()
        .filter_map(|(key, value)| value.as_str().map(|s| (key, s.to_string())))
        .collect()
}

pub fn load_personal_env() -> anyhow::Result<HashMap<String, String>> {
    let Some(paths) = SecretStorePaths::for_home_dir() else {
        return Ok(HashMap::new());
    };

    match read_secret_blob(&paths) {
        Ok(map) => Ok(string_env_from_map(map)),
        Err(err) => {
            warn!(error = %err, "Failed to read personal secrets; using empty env");
            Ok(HashMap::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::{Aead, KeyInit};
    use crate::test_util::{home_env_lock, HomeGuard};
    use rand::RngCore;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_secret_blob_for_test(
        paths: &SecretStorePaths,
        map: &serde_json::Map<String, serde_json::Value>,
    ) {
        std::fs::create_dir_all(
            paths
                .master_key_path
                .parent()
                .expect("master key has parent"),
        )
        .unwrap();

        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        std::fs::write(&paths.master_key_path, key).unwrap();

        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let plaintext = serde_json::to_vec(map).unwrap();
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, plaintext.as_ref()).unwrap();

        let file = EncryptedBlobFile {
            nonce_b64: B64.encode(nonce_bytes),
            ciphertext_b64: B64.encode(ciphertext),
        };
        let blob_bytes = serde_json::to_vec_pretty(&file).unwrap();
        std::fs::File::create(&paths.blob_path)
            .unwrap()
            .write_all(&blob_bytes)
            .unwrap();
    }

    #[test]
    fn load_personal_env_reads_encrypted_blob() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let secrets_dir = dir.path().join(format!(".{}", APP_SECRETS_DIR)).join("secrets");
        let paths = SecretStorePaths::for_base_dir(secrets_dir);
        let mut map = serde_json::Map::new();
        map.insert("my_key".into(), serde_json::Value::String("secret".into()));
        write_secret_blob_for_test(&paths, &map);

        let env = load_personal_env().unwrap();
        assert_eq!(env.get("my_key"), Some(&"secret".to_string()));
    }

    #[test]
    fn load_personal_env_skips_non_string_values() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let secrets_dir = dir.path().join(format!(".{}", APP_SECRETS_DIR)).join("secrets");
        let paths = SecretStorePaths::for_base_dir(secrets_dir);
        let mut map = serde_json::Map::new();
        map.insert("str_key".into(), serde_json::Value::String("value".into()));
        map.insert("num_key".into(), serde_json::Value::Number(42.into()));
        write_secret_blob_for_test(&paths, &map);

        let env = load_personal_env().unwrap();
        assert_eq!(env.get("str_key"), Some(&"value".to_string()));
        assert!(!env.contains_key("num_key"));
    }

    #[test]
    fn load_personal_env_returns_empty_when_blob_missing() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let env = load_personal_env().unwrap();
        assert!(env.is_empty());
    }

    #[test]
    fn load_personal_env_returns_empty_on_decrypt_failure() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let secrets_dir = dir.path().join(format!(".{}", APP_SECRETS_DIR)).join("secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let paths = SecretStorePaths::for_base_dir(secrets_dir);
        let mut map = serde_json::Map::new();
        map.insert("my_key".into(), serde_json::Value::String("secret".into()));
        write_secret_blob_for_test(&paths, &map);

        let mut blob = std::fs::read(&paths.blob_path).unwrap();
        blob[0] ^= 0x01;
        std::fs::write(&paths.blob_path, blob).unwrap();

        let env = load_personal_env().unwrap();
        assert!(env.is_empty());
    }
}
