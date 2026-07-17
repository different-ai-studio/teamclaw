use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    CloudApi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudApiConfig {
    pub url: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderConfig {
    CloudApi(CloudApiConfig),
}

impl ProviderConfig {
    pub fn kind(&self) -> ProviderKind {
        match self {
            ProviderConfig::CloudApi(_) => ProviderKind::CloudApi,
        }
    }

    pub fn default_path() -> Result<PathBuf, ProviderConfigError> {
        let dir = dirs::home_dir()
            .ok_or_else(|| ProviderConfigError::Config("no home dir".to_string()))?
            .join(".amuxd");
        Ok(dir.join("backend.toml"))
    }

    /// Whether *any* onboarding config exists at `backend_path` — either the
    /// real `backend.toml` or a legacy `supabase.toml` awaiting migration.
    ///
    /// Callers use this to tell "this daemon has never been onboarded" apart
    /// from "onboarding config exists but is corrupt". The former is a normal
    /// first-run state that starts unclaimed; the latter must stay a hard
    /// error rather than silently discarding a broken config and re-onboarding.
    pub fn exists_at(backend_path: &Path) -> bool {
        backend_path.exists()
            || backend_path
                .parent()
                .map(|dir| dir.join("supabase.toml").exists())
                .unwrap_or(false)
    }

    pub fn load_from_path(backend_path: &Path) -> Result<Self, ProviderConfigError> {
        if backend_path.exists() {
            return Self::load_backend_toml(backend_path);
        }

        let legacy_supabase_path = backend_path
            .parent()
            .map(|dir| dir.join("supabase.toml"))
            .ok_or_else(|| {
                ProviderConfigError::Config("backend.toml has no parent directory".to_string())
            })?;

        if legacy_supabase_path.exists() {
            let migrated = Self::migrate_legacy_supabase_toml(&legacy_supabase_path)?;
            Self::write_backend_toml(backend_path, &migrated)?;
            tracing::info!(
                backend = %backend_path.display(),
                legacy = %legacy_supabase_path.display(),
                "migrated legacy supabase.toml to backend.toml (kind = cloud_api)"
            );
            return Ok(ProviderConfig::CloudApi(migrated));
        }

        Err(ProviderConfigError::Config(format!(
            "backend.toml not found at {} (legacy supabase.toml also missing at {})",
            backend_path.display(),
            legacy_supabase_path.display()
        )))
    }

    fn migrate_legacy_supabase_toml(path: &Path) -> Result<CloudApiConfig, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let legacy: LegacySupabaseToml = toml::from_str(&text).map_err(|e| {
            ProviderConfigError::Config(format!(
                "parse legacy supabase.toml at {}: {e}",
                path.display()
            ))
        })?;
        if legacy.refresh_token.trim().is_empty() {
            return Err(ProviderConfigError::Config(format!(
                "legacy supabase.toml at {} is missing refresh_token",
                path.display()
            )));
        }
        Ok(CloudApiConfig {
            url: resolve_cloud_api_url()?,
            refresh_token: legacy.refresh_token,
            team_id: legacy.team_id,
            actor_id: legacy.actor_id,
        })
    }

    /// Persist a `cloud_api` backend config to `path`, atomically.
    ///
    /// Used both by the legacy `supabase.toml` migration and at runtime to write
    /// back a rotated refresh token, so the write must be crash-safe: a torn
    /// write here would lose the only credential the daemon has.
    pub fn save_cloud_api(path: &Path, cfg: &CloudApiConfig) -> Result<(), ProviderConfigError> {
        Self::write_backend_toml(path, cfg)
    }

    fn write_backend_toml(path: &Path, cfg: &CloudApiConfig) -> Result<(), ProviderConfigError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = format!(
            r#"kind = "cloud_api"

[cloud_api]
url = {url}
refresh_token = {refresh_token}
team_id = {team_id}
actor_id = {actor_id}
"#,
            url = toml_quote(&cfg.url),
            refresh_token = toml_quote(&cfg.refresh_token),
            team_id = toml_quote(&cfg.team_id),
            actor_id = toml_quote(&cfg.actor_id),
        );
        // Write to a sibling temp file then rename, so a crash mid-write can
        // never leave a partially written backend.toml.
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    fn load_backend_toml(path: &Path) -> Result<Self, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let file: BackendConfigFile = toml::from_str(&text)?;
        match file.kind.as_str() {
            "cloud_api" => file.cloud_api.map(ProviderConfig::CloudApi).ok_or_else(|| {
                ProviderConfigError::Config(
                    "[cloud_api] section is required when kind = \"cloud_api\"".to_string(),
                )
            }),
            other => Err(ProviderConfigError::Config(format!(
                "unsupported backend kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Deserialize)]
struct BackendConfigFile {
    kind: String,
    #[serde(default)]
    cloud_api: Option<CloudApiConfig>,
}

/// Flat `~/.amuxd/supabase.toml` written by older `amuxd init` flows.
#[derive(Debug, Deserialize)]
struct LegacySupabaseToml {
    #[allow(dead_code)]
    url: Option<String>,
    #[allow(dead_code)]
    anon_key: Option<String>,
    refresh_token: String,
    team_id: String,
    actor_id: String,
}

fn resolve_cloud_api_url() -> Result<String, ProviderConfigError> {
    if let Ok(url) = std::env::var("TEAMCLAW_CLOUD_API_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err(ProviderConfigError::MissingCloudApiUrl)
}

fn toml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("parse backend.toml: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("provider config error: {0}")]
    Config(String),
    #[error("Cloud API URL not configured. Set TEAMCLAW_CLOUD_API_URL env var.")]
    MissingCloudApiUrl,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_cloud_api_backend_toml() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(
            &backend_path,
            r#"
kind = "cloud_api"

[cloud_api]
url = "https://fc.example.com"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        let loaded = ProviderConfig::load_from_path(&backend_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded;
        assert_eq!(config.url, "https://fc.example.com");
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
    }

    #[test]
    fn migrates_legacy_supabase_toml_when_backend_toml_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let legacy_path = dir.path().join("supabase.toml");
        std::fs::write(
            &legacy_path,
            r#"
url = "https://project.supabase.co"
anon_key = "anon"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        // Migration requires TEAMCLAW_CLOUD_API_URL to be set.
        std::env::set_var("TEAMCLAW_CLOUD_API_URL", "https://teamclaw-api.ucar.cc");
        let loaded = ProviderConfig::load_from_path(&backend_path).unwrap();
        std::env::remove_var("TEAMCLAW_CLOUD_API_URL");
        assert!(backend_path.exists());
        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded;
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
        assert_eq!(config.url, "https://teamclaw-api.ucar.cc");
    }

    #[test]
    fn rejects_when_backend_and_legacy_supabase_toml_are_missing() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let err = ProviderConfig::load_from_path(&backend_path).expect_err("missing should fail");
        assert!(err.to_string().contains("backend.toml not found"));
        assert!(err.to_string().contains("supabase.toml also missing"));
    }

    #[test]
    fn rejects_unknown_kind() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(&backend_path, r#"kind = "mythical""#).unwrap();
        let err = ProviderConfig::load_from_path(&backend_path)
            .expect_err("unknown kind should fail");
        assert!(err.to_string().contains("unsupported backend kind"));
    }
}
