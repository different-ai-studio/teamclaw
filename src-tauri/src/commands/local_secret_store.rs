use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

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

fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut perms = std::fs::metadata(path)
            .map_err(|e| {
                format!(
                    "Failed to inspect permissions for {}: {}",
                    path.display(),
                    e
                )
            })?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("Failed to set permissions for {}: {}", path.display(), e))?;
    }

    Ok(())
}

fn load_or_create_master_key(paths: &SecretStorePaths) -> Result<[u8; 32], String> {
    ensure_base_dir(paths)?;
    for _ in 0..50 {
        let mut open_options = std::fs::OpenOptions::new();
        open_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            open_options.mode(0o600);
        }

        match open_options.open(&paths.master_key_path) {
            Ok(mut file) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                let write_result = (|| -> Result<[u8; 32], String> {
                    file.write_all(&key)
                        .map_err(|e| format!("Failed to write master key: {}", e))?;
                    file.sync_all()
                        .map_err(|e| format!("Failed to flush master key: {}", e))?;
                    set_owner_only_permissions(&paths.master_key_path)?;
                    Ok(key)
                })();

                match write_result {
                    Ok(key) => return Ok(key),
                    Err(err) => {
                        let _ = std::fs::remove_file(&paths.master_key_path);
                        return Err(err);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let raw = match std::fs::read(&paths.master_key_path) {
                    Ok(raw) => raw,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(err) => return Err(format!("Failed to read master key: {}", err)),
                };

                match raw.try_into() {
                    Ok(key) => {
                        set_owner_only_permissions(&paths.master_key_path)?;
                        return Ok(key);
                    }
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                }
            }
            Err(e) => return Err(format!("Failed to create master key: {}", e)),
        }
    }

    Err("Failed to initialize master key after retries".to_string())
}

fn load_existing_master_key(paths: &SecretStorePaths) -> Result<[u8; 32], String> {
    let raw = std::fs::read(&paths.master_key_path)
        .map_err(|_| "Missing master key for existing encrypted secret store".to_string())?;
    let key: [u8; 32] = raw
        .try_into()
        .map_err(|_| "Invalid master key length".to_string())?;
    set_owner_only_permissions(&paths.master_key_path)?;
    Ok(key)
}

pub(crate) fn write_secret_blob(
    paths: &SecretStorePaths,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    ensure_base_dir(paths)?;
    let migrated_from_keychain = read_meta(paths)
        .ok()
        .map(|m| m.migrated_from_keychain)
        .unwrap_or(false);
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

    let blob_bytes = serde_json::to_vec_pretty(&file)
        .map_err(|e| format!("Failed to encode blob file: {}", e))?;
    write_blob_atomically(&paths.blob_path, &blob_bytes)?;

    write_meta(
        paths,
        SecretStoreMeta {
            version: LOCAL_SECRETS_VERSION,
            algorithm: "aes-256-gcm".to_string(),
            migrated_from_keychain,
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

pub(crate) fn migrate_from_legacy_map_if_needed(
    paths: &SecretStorePaths,
    legacy_map: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<(), String> {
    if paths.blob_path.exists() {
        return Ok(());
    }

    let had_legacy_data = legacy_map.is_some();
    let map = legacy_map.unwrap_or_default();
    write_secret_blob(paths, &map)?;

    if had_legacy_data {
        write_meta(
            paths,
            SecretStoreMeta {
                version: LOCAL_SECRETS_VERSION,
                algorithm: "aes-256-gcm".to_string(),
                migrated_from_keychain: true,
            },
        )?;
    }

    Ok(())
}

pub(crate) fn read_or_migrate_secret_blob<F>(
    paths: &SecretStorePaths,
    legacy_reader: F,
) -> Result<serde_json::Map<String, serde_json::Value>, String>
where
    F: FnOnce() -> Result<Option<serde_json::Map<String, serde_json::Value>>, String>,
{
    if paths.blob_path.exists() {
        return read_secret_blob(paths);
    }

    let legacy_map = legacy_reader()?;
    migrate_from_legacy_map_if_needed(paths, legacy_map)?;
    read_secret_blob(paths)
}

fn write_blob_atomically(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("Blob path has no parent directory: {}", target.display()))?;
    let stem = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid blob file name: {}", target.display()))?;

    for _ in 0..50 {
        let tmp_path = parent.join(format!(
            ".{}.{}.{}.tmp",
            stem,
            std::process::id(),
            rand::thread_rng().next_u64()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(mut file) => {
                let write_result = (|| -> Result<(), String> {
                    file.write_all(bytes)
                        .map_err(|e| format!("Failed to write temp blob file: {}", e))?;
                    file.sync_all()
                        .map_err(|e| format!("Failed to flush temp blob file: {}", e))?;
                    Ok(())
                })();

                if let Err(err) = write_result {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(err);
                }

                match std::fs::rename(&tmp_path, target) {
                    Ok(()) => return Ok(()),
                    Err(e) => {
                        let _ = std::fs::remove_file(&tmp_path);
                        return Err(format!("Failed to atomically replace blob file: {}", e));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create temp blob file: {}", e)),
        }
    }

    Err("Failed to create unique temp blob file after retries".to_string())
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
        map.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("sk-test".into()),
        );

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

    #[test]
    fn meta_round_trip_writes_and_reads() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let meta = SecretStoreMeta {
            version: LOCAL_SECRETS_VERSION,
            algorithm: "aes-256-gcm".to_string(),
            migrated_from_keychain: true,
        };

        write_meta(&paths, meta).unwrap();
        let loaded = read_meta(&paths).unwrap();

        assert_eq!(loaded.version, LOCAL_SECRETS_VERSION);
        assert_eq!(loaded.algorithm, "aes-256-gcm");
        assert!(loaded.migrated_from_keychain);
    }

    #[test]
    fn migration_writes_local_blob_from_legacy_map() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let mut legacy_map = serde_json::Map::new();
        legacy_map.insert("A".into(), serde_json::Value::String("B".into()));

        migrate_from_legacy_map_if_needed(&paths, Some(legacy_map.clone())).unwrap();

        let loaded = read_secret_blob(&paths).unwrap();
        let meta = read_meta(&paths).unwrap();

        assert_eq!(loaded, legacy_map);
        assert!(meta.migrated_from_keychain);
    }

    #[test]
    fn migration_is_noop_when_encrypted_blob_already_exists() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let mut existing_map = serde_json::Map::new();
        existing_map.insert("EXISTING".into(), serde_json::Value::String("VALUE".into()));
        write_secret_blob(&paths, &existing_map).unwrap();

        let mut legacy_map = serde_json::Map::new();
        legacy_map.insert(
            "LEGACY".into(),
            serde_json::Value::String("SHOULD_NOT_WIN".into()),
        );

        migrate_from_legacy_map_if_needed(&paths, Some(legacy_map)).unwrap();

        let loaded = read_secret_blob(&paths).unwrap();
        let meta = read_meta(&paths).unwrap();

        assert_eq!(loaded, existing_map);
        assert!(!meta.migrated_from_keychain);
    }

    #[test]
    fn read_or_migrate_initializes_empty_store_when_both_missing() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());

        let loaded = read_or_migrate_secret_blob(&paths, || Ok(None)).unwrap();
        let meta = read_meta(&paths).unwrap();

        assert!(loaded.is_empty());
        assert!(!meta.migrated_from_keychain);
    }

    #[test]
    fn read_or_migrate_uses_legacy_reader_once_then_prefers_local_blob() {
        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let legacy_reads = std::sync::atomic::AtomicUsize::new(0);

        let first = read_or_migrate_secret_blob(&paths, || {
            legacy_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

            let mut legacy_map = serde_json::Map::new();
            legacy_map.insert(
                "OPENAI_API_KEY".into(),
                serde_json::Value::String("migrated-secret".into()),
            );
            Ok(Some(legacy_map))
        })
        .unwrap();

        assert_eq!(
            first.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("migrated-secret")
        );
        assert_eq!(legacy_reads.load(std::sync::atomic::Ordering::SeqCst), 1);

        let second = read_or_migrate_secret_blob(&paths, || {
            legacy_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err("legacy reader should not run after local blob exists".to_string())
        })
        .unwrap();

        assert_eq!(second, first);
        assert_eq!(legacy_reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn existing_master_key_permissions_are_corrected() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        std::fs::create_dir_all(&paths.base_dir).unwrap();

        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&paths.master_key_path)
            .unwrap();
        file.write_all(&key).unwrap();
        file.sync_all().unwrap();

        let loaded = load_or_create_master_key(&paths).unwrap();
        assert_eq!(loaded, key);

        let mode = std::fs::metadata(&paths.master_key_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn read_path_repairs_existing_master_key_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let paths = SecretStorePaths::for_base_dir(dir.path().to_path_buf());
        let mut map = serde_json::Map::new();
        map.insert("A".into(), serde_json::Value::String("B".into()));

        write_secret_blob(&paths, &map).unwrap();
        let mut perms = std::fs::metadata(&paths.master_key_path)
            .unwrap()
            .permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&paths.master_key_path, perms).unwrap();

        let loaded = read_secret_blob(&paths).unwrap();
        assert_eq!(loaded.get("A").and_then(|v| v.as_str()), Some("B"));

        let mode = std::fs::metadata(&paths.master_key_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
