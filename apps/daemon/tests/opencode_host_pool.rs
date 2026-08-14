include!("support/crate_modules.rs");

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::Barrier;

use runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use runtime::opencode_http::client::{PromptBody, PromptPart};
use runtime::opencode_http::host_pool::{
    GenerationFactory, HostGeneration, HostLifecycle, OpenCodeHostPool,
};
use runtime::opencode_http::supervisor::{ServeSupervisor, ShutdownOutcome};

#[derive(Clone)]
struct FixtureState {
    sentinel: String,
    prompt_barrier: Option<Arc<Barrier>>,
    observed: Arc<Mutex<Vec<String>>>,
}

struct Fixture {
    observed: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct FixtureFactory {
    fixtures: Mutex<HashMap<String, Fixture>>,
    starts: Mutex<Vec<(String, IsolationDomainKey, String)>>,
    stopped: Mutex<Vec<String>>,
    prompt_barrier: Mutex<Option<Arc<Barrier>>>,
}

impl FixtureFactory {
    fn with_prompt_barrier(parties: usize) -> Arc<Self> {
        Arc::new(Self {
            prompt_barrier: Mutex::new(Some(Arc::new(Barrier::new(parties)))),
            ..Self::default()
        })
    }

    fn starts(&self) -> Vec<(String, IsolationDomainKey, String)> {
        self.starts.lock().clone()
    }

    fn stopped(&self) -> Vec<String> {
        self.stopped.lock().clone()
    }

    fn observed(&self, generation_id: &str) -> Vec<String> {
        self.fixtures.lock()[generation_id].observed.lock().clone()
    }
}

#[async_trait]
impl GenerationFactory for FixtureFactory {
    async fn start(
        &self,
        generation_id: String,
        domain: IsolationDomainKey,
        revision: ProcessEnvRevision,
        env: HashMap<String, String>,
    ) -> Result<Arc<ServeSupervisor>, String> {
        let sentinel = env
            .get("SENTINEL")
            .cloned()
            .ok_or_else(|| "fixture requires SENTINEL".to_string())?;
        let observed = Arc::new(Mutex::new(Vec::new()));
        let state = FixtureState {
            sentinel: sentinel.clone(),
            prompt_barrier: self.prompt_barrier.lock().clone(),
            observed: Arc::clone(&observed),
        };
        let app = Router::new()
            .route("/session/:session_id/prompt_async", post(prompt_async))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| error.to_string())?;
        let base_url = format!(
            "http://{}",
            listener.local_addr().map_err(|error| error.to_string())?
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        self.starts
            .lock()
            .push((generation_id.clone(), domain, sentinel));
        self.fixtures
            .lock()
            .insert(generation_id.clone(), Fixture { observed, task });
        Ok(Arc::new(ServeSupervisor::test_with_base_url(
            generation_id,
            revision,
            base_url,
        )))
    }

    fn stop(&self, generation: &HostGeneration) -> ShutdownOutcome {
        if let Some(fixture) = self.fixtures.lock().remove(&generation.generation_id) {
            fixture.task.abort();
        }
        self.stopped.lock().push(generation.generation_id.clone());
        ShutdownOutcome::Stopped
    }
}

async fn prompt_async(
    State(state): State<FixtureState>,
    Path(_session_id): Path<String>,
    Json(_body): Json<Value>,
) -> StatusCode {
    if let Some(barrier) = state.prompt_barrier {
        barrier.wait().await;
    }
    state.observed.lock().push(state.sentinel);
    StatusCode::NO_CONTENT
}

fn domain(workspace: &str) -> IsolationDomainKey {
    IsolationDomainKey::Workspace(workspace.to_string())
}

fn env(sentinel: &str) -> HashMap<String, String> {
    HashMap::from([("SENTINEL".to_string(), sentinel.to_string())])
}

fn revision(sentinel: &str) -> ProcessEnvRevision {
    ProcessEnvRevision::from_bindings(&env(sentinel))
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

async fn wait_for_queue(pool: &OpenCodeHostPool, waiting_domain: &IsolationDomainKey) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if pool.stats_for(waiting_domain).queued_acquisitions == 1 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fourth acquisition should wait at the hard limit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_turn_and_cross_workspace_cron_use_isolated_hosts_concurrently() {
    let factory = FixtureFactory::with_prompt_barrier(2);
    let pool = OpenCodeHostPool::new(factory.clone());

    let (desktop, cron) = tokio::join!(
        pool.acquire(domain("workspace-a"), revision("A"), env("A"), deadline()),
        pool.acquire(domain("workspace-b"), revision("B"), env("B"), deadline()),
    );
    let desktop = desktop.unwrap();
    let cron = cron.unwrap();
    let desktop_id = desktop.generation.generation_id.clone();
    let cron_id = cron.generation.generation_id.clone();
    let desktop_client = desktop.generation.serve.ensure().await.unwrap();
    let cron_client = cron.generation.serve.ensure().await.unwrap();

    assert_ne!(desktop_client.base_url(), cron_client.base_url());
    let body = PromptBody {
        model: None,
        parts: vec![PromptPart::Text {
            text: "read SENTINEL".into(),
        }],
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::try_join!(
            desktop_client.prompt_async("/workspace-a", "desktop-session", &body),
            cron_client.prompt_async("/workspace-b", "cron-session", &body),
        )
    })
    .await
    .expect("both turns must enter their fixtures concurrently")
    .unwrap();

    assert_eq!(factory.observed(&desktop_id), ["A"]);
    assert_eq!(factory.observed(&cron_id), ["B"]);
    assert_eq!(factory.starts().len(), 2);
}

#[tokio::test]
async fn revision_roll_keeps_old_session_draining_until_its_detach() {
    let factory = Arc::new(FixtureFactory::default());
    let pool = OpenCodeHostPool::new(factory.clone());
    let old = pool
        .acquire(domain("workspace-a"), revision("A1"), env("A1"), deadline())
        .await
        .unwrap();
    let old_id = old.generation.generation_id.clone();

    let new = pool
        .acquire(domain("workspace-a"), revision("A2"), env("A2"), deadline())
        .await
        .unwrap();
    let new_id = new.generation.generation_id.clone();

    assert_ne!(old_id, new_id);
    assert_eq!(new.generation.lifecycle(), HostLifecycle::Ready);
    assert_eq!(old.generation.lifecycle(), HostLifecycle::Draining);
    assert_eq!(pool.stats_for(&domain("workspace-a")).draining_routes, 1);

    drop(old);

    assert_eq!(factory.stopped(), [old_id]);
    assert_eq!(
        pool.stats_for(&domain("workspace-a"))
            .current_generation
            .as_deref(),
        Some(new_id.as_str())
    );
    assert_eq!(new.generation.lifecycle(), HostLifecycle::Ready);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fourth_generation_waits_until_detach_without_evicting_active_hosts() {
    let factory = Arc::new(FixtureFactory::default());
    let pool = OpenCodeHostPool::new(factory.clone());
    let a = pool
        .acquire(domain("a"), revision("A"), env("A"), deadline())
        .await
        .unwrap();
    let b = pool
        .acquire(domain("b"), revision("B"), env("B"), deadline())
        .await
        .unwrap();
    let c = pool
        .acquire(domain("c"), revision("C"), env("C"), deadline())
        .await
        .unwrap();
    let a_id = a.generation.generation_id.clone();
    let b_id = b.generation.generation_id.clone();
    let c_id = c.generation.generation_id.clone();

    let waiting_pool = Arc::clone(&pool);
    let fourth = tokio::spawn(async move {
        waiting_pool
            .acquire(domain("d"), revision("D"), env("D"), deadline())
            .await
    });
    wait_for_queue(&pool, &domain("d")).await;

    assert_eq!(factory.starts().len(), 3);
    assert!(factory.stopped().is_empty());
    assert_eq!(a.generation.lifecycle(), HostLifecycle::Ready);
    assert_eq!(b.generation.lifecycle(), HostLifecycle::Ready);
    assert_eq!(c.generation.lifecycle(), HostLifecycle::Ready);

    drop(a);
    let d = tokio::time::timeout(Duration::from_secs(10), fourth)
        .await
        .expect("detach should wake the fourth acquisition")
        .unwrap()
        .unwrap();

    assert_eq!(factory.stopped(), [a_id]);
    assert_eq!(b.generation.generation_id, b_id);
    assert_eq!(c.generation.generation_id, c_id);
    assert_eq!(b.generation.lifecycle(), HostLifecycle::Ready);
    assert_eq!(c.generation.lifecycle(), HostLifecycle::Ready);
    assert_eq!(d.generation.lifecycle(), HostLifecycle::Ready);
}
