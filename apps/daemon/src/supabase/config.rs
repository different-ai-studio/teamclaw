use crate::supabase::error::{SupabaseError, SupabaseResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

impl SupabaseConfig {
    pub fn load(path: &Path) -> SupabaseResult<Self> {
        let text = fs::read_to_string(path)?;
        let cfg: SupabaseConfig =
            toml::from_str(&text).map_err(|e| SupabaseError::Config(format!("parse: {e}")))?;
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> SupabaseResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let text =
            toml::to_string(self).map_err(|e| SupabaseError::Config(format!("serialize: {e}")))?;
        fs::write(path, text)?;
        Ok(())
    }

    pub fn default_path() -> SupabaseResult<PathBuf> {
        let dir =
            dirs::config_dir().ok_or_else(|| SupabaseError::Config("no config dir".into()))?;
        Ok(dir.join("amux").join("supabase.toml"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trip_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("supabase.toml");

        let cfg = SupabaseConfig {
            url: "https://example.supabase.co".into(),
            anon_key: "anon".into(),
            refresh_token: "refresh".into(),
            team_id: "team".into(),
            actor_id: "actor".into(),
        };
        cfg.save(&path).unwrap();

        let loaded = SupabaseConfig::load(&path).unwrap();
        assert_eq!(cfg, loaded);
    }

    #[test]
    fn load_missing_file_returns_io_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.toml");
        assert!(matches!(
            SupabaseConfig::load(&path),
            Err(SupabaseError::Io(_))
        ));
    }

    #[test]
    fn save_creates_parent_directory() {
        let dir = tempdir().unwrap();
        let path = dir
            .path()
            .join("nested")
            .join("deeper")
            .join("supabase.toml");

        let cfg = SupabaseConfig {
            url: "u".into(),
            anon_key: "a".into(),
            refresh_token: "r".into(),
            team_id: "t".into(),
            actor_id: "x".into(),
        };
        cfg.save(&path).unwrap();
        assert!(path.exists());
    }
}
