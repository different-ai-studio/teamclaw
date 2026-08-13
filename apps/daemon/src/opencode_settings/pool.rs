use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use crate::runtime::execution_context::{ExecutionContext, ProcessEnvRevision};
use crate::runtime::opencode_http::host_pool::OpenCodeHostPool;

use super::client::OpenCodeSettingsClient;
use super::OpenCodeSettingsError;

#[async_trait]
pub trait WorkspaceSettingsContextResolver: Send + Sync {
    async fn resolve_settings_context(&self, workspace: &Path) -> Result<ExecutionContext, String>;
}

/// Provider OAuth / auth-method discovery over the workspace's pooled host.
pub struct OpenCodeSettingsService {
    pool: Option<Arc<OpenCodeHostPool>>,
    context_resolver: Option<Arc<dyn WorkspaceSettingsContextResolver>>,
    /// Test hook: fixed base URL per workspace path (wiremock), skips ensure().
    test_fixtures: Mutex<HashMap<String, String>>,
}

impl OpenCodeSettingsService {
    pub fn with_host_pool(
        pool: Arc<OpenCodeHostPool>,
        context_resolver: Arc<dyn WorkspaceSettingsContextResolver>,
    ) -> Self {
        Self {
            pool: Some(pool),
            context_resolver: Some(context_resolver),
            test_fixtures: Mutex::new(HashMap::new()),
        }
    }

    /// Tests / callers without a live pool. Live OpenCode calls need
    /// [`Self::inject_test_base_url`] or [`Self::with_host_pool`].
    pub fn new(_opencode_binary: impl Into<String>) -> Self {
        Self {
            pool: None,
            context_resolver: None,
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

        let (Some(pool), Some(resolver)) = (&self.pool, &self.context_resolver) else {
            return Err(OpenCodeSettingsError::SpawnFailed(
                "opencode settings has no host pool (and no test fixture)".into(),
            ));
        };

        let context = resolver
            .resolve_settings_context(workspace)
            .await
            .map_err(OpenCodeSettingsError::SpawnFailed)?;
        let revision = ProcessEnvRevision::from_bindings(&context.spawn_env.extra_env);
        let lease = pool
            .acquire(
                context.isolation_domain,
                revision,
                context.spawn_env.extra_env,
                Instant::now() + Duration::from_secs(30),
            )
            .await
            .map_err(|error| OpenCodeSettingsError::SpawnFailed(error.to_string()))?;
        let client = lease.generation.serve.ensure().await.map_err(|e| {
            OpenCodeSettingsError::SpawnFailed(format!("ensure workspace opencode serve: {e}"))
        })?;
        Ok(OpenCodeSettingsClient::with_auth(
            client.base_url().to_string(),
            client.password().to_string(),
            workspace,
        ))
    }
}

#[cfg(test)]
mod pool_aware_tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::runtime::execution_context::{
        ExecutionContext, IsolationDomainKey, ProcessEnvRevision, WorkspaceIdentity,
    };
    use crate::runtime::opencode_http::host_pool::{
        GenerationFactory, HostGeneration, OpenCodeHostPool,
    };
    use crate::runtime::opencode_http::supervisor::{ServeSupervisor, ShutdownOutcome};

    struct FixtureFactory {
        starts: AtomicUsize,
        urls: HashMap<String, String>,
    }

    #[async_trait]
    impl GenerationFactory for FixtureFactory {
        async fn start(
            &self,
            generation_id: String,
            domain: IsolationDomainKey,
            revision: ProcessEnvRevision,
            _env: HashMap<String, String>,
        ) -> Result<Arc<ServeSupervisor>, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            let workspace_id = match domain {
                IsolationDomainKey::Workspace(id) => id,
                _ => "unscoped".to_string(),
            };
            Ok(Arc::new(ServeSupervisor::test_with_base_url(
                generation_id,
                revision,
                self.urls
                    .get(&workspace_id)
                    .cloned()
                    .unwrap_or_else(|| "http://127.0.0.1:41003".to_string()),
            )))
        }

        fn stop(&self, _generation: &HostGeneration) -> ShutdownOutcome {
            ShutdownOutcome::Stopped
        }
    }

    struct FixtureResolver {
        root_a: std::path::PathBuf,
        root_b: std::path::PathBuf,
    }

    #[async_trait]
    impl WorkspaceSettingsContextResolver for FixtureResolver {
        async fn resolve_settings_context(
            &self,
            workspace: &Path,
        ) -> Result<ExecutionContext, String> {
            let workspace_id = if workspace == self.root_a {
                "ws-a"
            } else {
                "ws-b"
            };
            Ok(ExecutionContext {
                isolation_domain: IsolationDomainKey::Workspace(workspace_id.into()),
                workspace: Some(WorkspaceIdentity {
                    workspace_id: workspace_id.into(),
                    workspace_root: workspace.to_path_buf(),
                    team_id: Some("team-a".into()),
                }),
                working_directory: workspace.to_path_buf(),
                spawn_env: crate::runtime::SpawnRuntimeEnv::default(),
            })
        }
    }

    fn pooled_service() -> (
        OpenCodeSettingsService,
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<FixtureFactory>,
    ) {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let factory = Arc::new(FixtureFactory {
            starts: AtomicUsize::new(0),
            urls: HashMap::from([
                ("ws-a".into(), "http://127.0.0.1:41001".into()),
                ("ws-b".into(), "http://127.0.0.1:41002".into()),
            ]),
        });
        let pool = OpenCodeHostPool::new(factory.clone());
        let resolver = Arc::new(FixtureResolver {
            root_a: a.path().to_path_buf(),
            root_b: b.path().to_path_buf(),
        });
        (
            OpenCodeSettingsService::with_host_pool(pool, resolver),
            a,
            b,
            factory,
        )
    }

    #[tokio::test]
    async fn settings_clients_for_two_workspaces_use_distinct_host_urls() {
        let (service, a, b, factory) = pooled_service();

        let client_a = service.client_for_workspace(a.path()).await.unwrap();
        let client_b = service.client_for_workspace(b.path()).await.unwrap();

        assert_ne!(client_a.base_url(), client_b.base_url());
        assert_eq!(factory.starts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn model_catalog_for_b_never_uses_a_generation() {
        let server_a = MockServer::start().await;
        let server_b = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/provider"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server_a)
            .await;
        Mock::given(method("GET"))
            .and(path("/provider"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "connected": ["provider-b"],
                "all": [{"id": "provider-b", "name": "Provider B", "models": {}}]
            })))
            .expect(1)
            .mount(&server_b)
            .await;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let factory = Arc::new(FixtureFactory {
            starts: AtomicUsize::new(0),
            urls: HashMap::from([
                ("ws-a".into(), server_a.uri()),
                ("ws-b".into(), server_b.uri()),
            ]),
        });
        let pool = OpenCodeHostPool::new(factory.clone());
        let service = OpenCodeSettingsService::with_host_pool(
            pool,
            Arc::new(FixtureResolver {
                root_a: a.path().to_path_buf(),
                root_b: b.path().to_path_buf(),
            }),
        );

        let catalog = service.provider_catalog(b.path()).await.unwrap();

        assert_eq!(catalog.connected, vec!["provider-b"]);
        assert_eq!(factory.starts.load(Ordering::SeqCst), 1);
    }
}
