use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::runtime::opencode_http::supervisor::ServeSupervisor;

use super::client::OpenCodeSettingsClient;
use super::OpenCodeSettingsError;

/// Provider OAuth / auth-method discovery over the **global** chat
/// `opencode serve` (same process as sessions).
///
/// Historically this spawned a second per-workspace serve (ACP-era split:
/// `serve` for settings, `acp` for chat). After the HTTP single-agent
/// refactor that is redundant and left orphan processes on daemon exit.
pub struct OpenCodeSettingsService {
    serve: Option<Arc<ServeSupervisor>>,
    /// Test hook: fixed base URL per workspace path (wiremock), skips ensure().
    test_fixtures: Mutex<HashMap<String, String>>,
}

impl OpenCodeSettingsService {
    /// Production: route settings HTTP through the global serve supervisor.
    pub fn with_global_serve(serve: Arc<ServeSupervisor>) -> Self {
        Self {
            serve: Some(serve),
            test_fixtures: Mutex::new(HashMap::new()),
        }
    }

    /// Tests / callers without a live serve. Live OpenCode calls need
    /// [`Self::inject_test_base_url`] or [`Self::with_global_serve`].
    pub fn new(_opencode_binary: impl Into<String>) -> Self {
        Self {
            serve: None,
            test_fixtures: Mutex::new(HashMap::new()),
        }
    }

    /// Inject a loopback base URL for a workspace (integration tests only).
    pub fn inject_test_base_url(&self, workspace: &Path, base_url: String) {
        self.test_fixtures
            .lock()
            .unwrap()
            .insert(workspace.to_string_lossy().to_string(), base_url);
    }

    pub async fn client_for_workspace(
        &self,
        workspace: &Path,
    ) -> Result<OpenCodeSettingsClient, OpenCodeSettingsError> {
        let key = workspace.to_string_lossy().to_string();

        if let Some(base) = self.test_fixtures.lock().unwrap().get(&key).cloned() {
            return Ok(OpenCodeSettingsClient::new(base, workspace));
        }

        let Some(serve) = self.serve.as_ref() else {
            return Err(OpenCodeSettingsError::SpawnFailed(
                "opencode settings has no global serve (and no test fixture)".into(),
            ));
        };

        let client = serve.ensure().await.map_err(|e| {
            OpenCodeSettingsError::SpawnFailed(format!("ensure global opencode serve: {e}"))
        })?;
        Ok(OpenCodeSettingsClient::with_auth(
            client.base_url().to_string(),
            client.password().to_string(),
            workspace,
        ))
    }
}
