//! Per-team sync dispatch: picks git vs OSS, serializes runs behind a per-team
//! mutex, and caches the last status for the HTTP status endpoint.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::sync::git::GitCredential;
use crate::sync::secret_store::SecretStore;

/// Whether an FC `share-mode` value selects git-backed sync (vs OSS / disabled).
pub fn git_mode(mode: &str) -> bool {
    matches!(mode, "managed_git" | "custom_git")
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub mode: Option<String>,
    pub last_sync_at: String,
    pub syncing: bool,
    pub last_error: Option<String>,
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SyncOptions {
    pub wipe_non_git: bool,
}

#[derive(Clone)]
pub struct SyncDispatcher {
    secrets: SecretStore,
    /// Cloud backend used to self-supply the FC bearer for OSS sync. `None` in
    /// tests / harnesses that never run a real OSS tick.
    backend: Option<Arc<dyn crate::backend::Backend>>,
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    status: Arc<Mutex<HashMap<String, SyncStatus>>>,
}

impl SyncDispatcher {
    pub fn new(secrets: SecretStore, backend: Option<Arc<dyn crate::backend::Backend>>) -> Self {
        Self {
            secrets,
            backend,
            locks: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn secrets(&self) -> &SecretStore {
        &self.secrets
    }

    pub async fn team_share_gate(&self, team_id: &str) -> crate::team_link::TeamShareGate {
        match &self.backend {
            Some(b) => crate::team_link::team_share_gate(b.as_ref(), team_id).await,
            None => crate::team_link::TeamShareGate::Enabled,
        }
    }

    /// `true` when the cloud API reports an enabled share mode. When no backend
    /// is wired (focused HTTP tests), returns `true` to preserve legacy link behavior.
    pub async fn is_team_share_enabled(&self, team_id: &str) -> bool {
        matches!(
            self.team_share_gate(team_id).await,
            crate::team_link::TeamShareGate::Enabled
        )
    }

    /// FC base URL for OSS sync: the cloud URL from the authenticated backend.
    /// Returns an error if no backend is configured or it exposes no URL.
    pub fn fc_endpoint(&self) -> Result<String, String> {
        self.backend
            .as_ref()
            .and_then(|b| b.cloud_base_url())
            .filter(|u| !u.trim().is_empty())
            .ok_or_else(|| "FC endpoint not configured: no cloud backend URL available".to_string())
    }

    /// The credential for git-backed sync.
    ///
    /// The secret store wins when it holds one: the desktop may have pushed it,
    /// or `amuxd team secrets set` may have placed a deliberate override that a
    /// re-fetch would silently undo. Falling back to the cloud is only valid for
    /// `managed_git`, where the cloud is the credential's system of record —
    /// `custom_git` and `oss` secrets are user-held and have no server-side copy,
    /// so a headless daemon can only get those from the CLI.
    async fn resolve_git_credential(
        &self,
        team_id: &str,
        mode: &str,
        auth_kind: Option<&str>,
    ) -> Result<GitCredential, String> {
        let stored = self.secrets.git_credential(team_id, auth_kind)?;
        if !matches!(stored, GitCredential::None) || mode != "managed_git" {
            return Ok(stored);
        }
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "no cloud backend for managed-git credential".to_string())?;
        let cred = backend
            .managed_git_credential(team_id)
            .await
            .map_err(|e| format!("fetch managed-git credential: {e}"))?;
        Ok(GitCredential::HttpsToken(format!(
            "{}:{}",
            cred.username, cred.token
        )))
    }

    /// FC bearer for OSS sync: the daemon's own auto-refreshing cloud token.
    pub async fn oss_jwt(&self) -> Result<String, String> {
        match &self.backend {
            Some(b) => b
                .auth_token()
                .await
                .map_err(|e| format!("daemon auth_token: {e}")),
            None => Err("no cloud backend available for OSS jwt".to_string()),
        }
    }

    pub async fn status(&self, team_id: &str) -> SyncStatus {
        self.status
            .lock()
            .await
            .get(team_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn team_lock(&self, team_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock().await;
        map.entry(team_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Sync one team for one workspace path. Serialized per team_id.
    pub async fn sync_team(
        &self,
        team_id: &str,
        workspace_path: &str,
        options: SyncOptions,
    ) -> SyncStatus {
        let lock = self.team_lock(team_id).await;
        let _guard = lock.lock().await;
        {
            let mut s = self.status.lock().await;
            s.entry(team_id.to_string()).or_default().syncing = true;
        }
        let result = self.run_once(team_id, workspace_path, options).await;
        let mut s = self.status.lock().await;
        let entry = s.entry(team_id.to_string()).or_default();
        match result {
            Ok(mut st) => {
                st.syncing = false;
                *entry = st;
            }
            Err(e) => {
                entry.syncing = false;
                entry.last_error = Some(e);
            }
        }
        entry.clone()
    }

    async fn run_once(
        &self,
        team_id: &str,
        _workspace_path: &str,
        options: SyncOptions,
    ) -> Result<SyncStatus, String> {
        use crate::sync::{git, oss};
        // Config (mode + git url + auth kind) comes from FC; the git branch +
        // credential come from the per-team secret store (FC does not surface
        // either). The workspace path is no longer consulted.
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "no cloud backend for sync".to_string())?;
        let share = backend
            .team_share_config(team_id)
            .await
            .map_err(|e| e.to_string())?;
        let global_dir = crate::config::global_team_store::global_team_dir(team_id);
        match share.mode.as_deref() {
            Some(m) if git_mode(m) => {
                let secrets = self.secrets.load(team_id)?;
                let cred = self
                    .resolve_git_credential(team_id, m, share.git_auth_kind.as_deref())
                    .await?;
                let cfg = git::TeamSharedGitConfig {
                    git_url: share.git_remote_url.clone(),
                    // FC has no branch; the secret store provides it (else git
                    // falls back to the remote default / `main`).
                    git_branch: secrets.git_branch.clone(),
                    git_token: None,
                    shared_dir_name: crate::config::global_team_store::TEAM_LINK_NAME.to_string(),
                    env_secret: None,
                    enabled: true,
                };
                let st = git::sync_git_dir_with_cred(
                    &global_dir,
                    &cfg,
                    cred,
                    git::GitSyncOptions {
                        wipe_non_git: options.wipe_non_git,
                    },
                )
                .map_err(|e| e.to_string())?;
                Ok(SyncStatus {
                    mode: Some("git".into()),
                    last_sync_at: now_rfc3339(),
                    // A conflict means local was hard-reset; surface it even if the
                    // backup-copy loop backed up zero files (e.g. a copy failure must
                    // not hide that local diverged and was overwritten).
                    conflicts: st
                        .conflict
                        .as_ref()
                        .map(|c| (c.backed_up.len() as u32).max(1))
                        .unwrap_or(0),
                    ..Default::default()
                })
            }
            Some("oss") => {
                let secret = self.secrets.resolve_team_secret(team_id, None)?;
                let jwt = self.oss_jwt().await?;
                let fc = oss::fc_client::FcClient::new(self.fc_endpoint()?, jwt);
                let content_root = global_dir.to_string_lossy().to_string();
                let r = oss::tick(&content_root, team_id, &secret, &fc)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(SyncStatus {
                    mode: Some("oss".into()),
                    last_sync_at: now_rfc3339(),
                    pulled: r.pulled,
                    pushed: r.pushed,
                    conflicts: r.conflicts,
                    ..Default::default()
                })
            }
            _ => Ok(SyncStatus {
                mode: None,
                last_sync_at: now_rfc3339(),
                ..Default::default()
            }),
        }
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_mode_true_for_managed_and_custom_git() {
        assert!(git_mode("managed_git"));
        assert!(git_mode("custom_git"));
    }
    #[test]
    fn git_mode_false_for_oss_and_unknown() {
        assert!(!git_mode("oss"));
        assert!(!git_mode(""));
        assert!(!git_mode("whatever"));
    }

    use crate::backend::mock::MockBackend;
    use crate::backend::ManagedGitCredential;
    use crate::sync::secret_store::TeamSecrets;

    /// A dispatcher over a throwaway secret store, plus the mock backend so
    /// tests can seed (or withhold) the cloud's managed-git credential.
    fn dispatcher_with_mock(tmp: &tempfile::TempDir) -> (SyncDispatcher, Arc<MockBackend>) {
        let backend = Arc::new(MockBackend::new());
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        let d = SyncDispatcher::new(store, Some(backend.clone()));
        (d, backend)
    }

    #[tokio::test]
    async fn managed_git_falls_back_to_cloud_credential_when_store_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let (d, backend) = dispatcher_with_mock(&tmp);
        backend.state().managed_git_credentials.insert(
            "t".into(),
            ManagedGitCredential {
                username: "bot".into(),
                token: "pat123".into(),
            },
        );
        // This is the headless case: no desktop ever pushed a credential.
        let cred = d
            .resolve_git_credential("t", "managed_git", Some("https_token"))
            .await
            .unwrap();
        assert!(matches!(cred, GitCredential::HttpsToken(c) if c == "bot:pat123"));
    }

    #[tokio::test]
    async fn stored_credential_wins_over_cloud_for_managed_git() {
        let tmp = tempfile::tempdir().unwrap();
        let (d, backend) = dispatcher_with_mock(&tmp);
        backend.state().managed_git_credentials.insert(
            "t".into(),
            ManagedGitCredential {
                username: "bot".into(),
                token: "pat123".into(),
            },
        );
        d.secrets()
            .merge(
                "t",
                &TeamSecrets {
                    git_credential: Some("stored:override".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let cred = d
            .resolve_git_credential("t", "managed_git", Some("https_token"))
            .await
            .unwrap();
        assert!(matches!(cred, GitCredential::HttpsToken(c) if c == "stored:override"));
    }

    #[tokio::test]
    async fn custom_git_never_fetches_from_cloud() {
        let tmp = tempfile::tempdir().unwrap();
        let (d, backend) = dispatcher_with_mock(&tmp);
        // Seeded, and still must not be used: a custom_git remote is not the
        // managed remote, so the managed credential would be the wrong secret.
        backend.state().managed_git_credentials.insert(
            "t".into(),
            ManagedGitCredential {
                username: "bot".into(),
                token: "pat123".into(),
            },
        );
        let cred = d
            .resolve_git_credential("t", "custom_git", Some("https_token"))
            .await
            .unwrap();
        assert!(matches!(cred, GitCredential::None));
    }

    #[tokio::test]
    async fn managed_git_surfaces_cloud_fetch_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let (d, _backend) = dispatcher_with_mock(&tmp);
        // Nothing stored, nothing seeded: the error must name the fetch, not
        // masquerade as a missing local secret.
        let err = d
            .resolve_git_credential("t", "managed_git", Some("https_token"))
            .await
            .unwrap_err();
        assert!(err.contains("managed-git credential"), "got: {err}");
    }
    #[test]
    fn fc_endpoint_errors_without_backend() {
        let d = SyncDispatcher::new(crate::sync::secret_store::SecretStore::new(), None);
        assert!(d.fc_endpoint().is_err());
    }
}
