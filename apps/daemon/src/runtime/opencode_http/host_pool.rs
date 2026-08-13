use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::process_registry::ServeProcessRegistry;
use super::supervisor::{ServeSupervisor, ShutdownOutcome};
use super::{Route, SseTransportState};
use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};

const HOST_IDLE_TTL: Duration = Duration::from_secs(300);
const HOST_SOFT_LIMIT: usize = 2;
const HOST_HARD_LIMIT: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostLifecycle {
    Starting,
    Ready,
    Draining,
    Stopped,
}

pub struct HostGeneration {
    pub generation_id: String,
    pub domain: IsolationDomainKey,
    pub process_env_revision: ProcessEnvRevision,
    pub serve: Arc<ServeSupervisor>,
    pub(crate) routes: parking_lot::Mutex<HashMap<String, Route>>,
    pub(crate) permissions: parking_lot::Mutex<HashMap<String, String>>,
    pub(crate) questions: parking_lot::Mutex<HashMap<String, String>>,
    pub(crate) sse_tasks: parking_lot::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    pub(crate) sse_transport: parking_lot::Mutex<HashMap<String, SseTransportState>>,
    lifecycle: parking_lot::RwLock<HostLifecycle>,
    route_count: AtomicUsize,
    idle_since: parking_lot::Mutex<Option<Instant>>,
    stop_lock: parking_lot::Mutex<()>,
}

impl HostGeneration {
    pub(crate) fn new(
        generation_id: String,
        domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        serve: Arc<ServeSupervisor>,
    ) -> Self {
        Self {
            generation_id,
            domain,
            process_env_revision,
            serve,
            routes: parking_lot::Mutex::new(HashMap::new()),
            permissions: parking_lot::Mutex::new(HashMap::new()),
            questions: parking_lot::Mutex::new(HashMap::new()),
            sse_tasks: parking_lot::Mutex::new(HashMap::new()),
            sse_transport: parking_lot::Mutex::new(HashMap::new()),
            lifecycle: parking_lot::RwLock::new(HostLifecycle::Ready),
            route_count: AtomicUsize::new(0),
            idle_since: parking_lot::Mutex::new(Some(Instant::now())),
            stop_lock: parking_lot::Mutex::new(()),
        }
    }

    pub fn lifecycle(&self) -> HostLifecycle {
        *self.lifecycle.read()
    }

    pub fn route_count(&self) -> usize {
        self.route_count.load(Ordering::Acquire)
    }

    fn reserve_route(self: &Arc<Self>, pool: &OpenCodeHostPool) -> HostLease {
        self.route_count.fetch_add(1, Ordering::AcqRel);
        *self.idle_since.lock() = None;
        HostLease {
            generation: Arc::clone(self),
            route_lease: Some(RouteLease {
                pool: pool.self_weak.clone(),
                generation: Arc::downgrade(self),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_for_routing(
        generation_id: &str,
        domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
    ) -> Arc<Self> {
        let registry_path = tempfile::tempdir()
            .expect("temporary process registry")
            .keep()
            .join("opencode-pgids.json");
        let serve = Arc::new(ServeSupervisor::new(
            generation_id.to_string(),
            Arc::new(ServeProcessRegistry::new(registry_path)),
            HashMap::new(),
            process_env_revision.clone(),
        ));
        Arc::new(Self::new(
            generation_id.to_string(),
            domain,
            process_env_revision,
            serve,
        ))
    }

    #[cfg(test)]
    pub(crate) fn test_route_lease(self: &Arc<Self>) -> RouteLease {
        self.route_count.fetch_add(1, Ordering::AcqRel);
        RouteLease {
            pool: Weak::new(),
            generation: Arc::downgrade(self),
        }
    }
}

pub struct HostLease {
    pub generation: Arc<HostGeneration>,
    route_lease: Option<RouteLease>,
}

impl HostLease {
    pub fn into_route_parts(mut self) -> (Arc<HostGeneration>, RouteLease) {
        let generation = Arc::clone(&self.generation);
        let route_lease = self
            .route_lease
            .take()
            .expect("host lease must own its route reservation");
        (generation, route_lease)
    }
}

impl fmt::Debug for HostLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostLease")
            .field("generation_id", &self.generation.generation_id)
            .finish()
    }
}

pub struct RouteLease {
    pool: Weak<OpenCodeHostPool>,
    generation: Weak<HostGeneration>,
}

impl fmt::Debug for RouteLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouteLease")
            .field(
                "generation_id",
                &self
                    .generation
                    .upgrade()
                    .map(|generation| generation.generation_id.clone()),
            )
            .finish()
    }
}

impl Drop for RouteLease {
    fn drop(&mut self) {
        let Some(generation) = self.generation.upgrade() else {
            return;
        };
        let previous = generation.route_count.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "route lease released more than once");
        if previous != 1 {
            return;
        }
        *generation.idle_since.lock() = Some(Instant::now());
        if let Some(pool) = self.pool.upgrade() {
            pool.route_released(generation);
        }
    }
}

#[derive(Debug, Eq, PartialEq, thiserror::Error)]
pub enum HostPoolError {
    #[error(
        "OpenCode host capacity timed out ({active} active, {draining} draining, {queued} queued)"
    )]
    CapacityTimeout {
        active: usize,
        draining: usize,
        queued: usize,
    },
    #[error("OpenCode host generation failed to start: {0}")]
    Spawn(String),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DomainHostStats {
    pub current_generation: Option<String>,
    pub current_lifecycle: Option<HostLifecycle>,
    pub current_revision: Option<String>,
    pub requested_revision: Option<String>,
    pub current_routes: usize,
    pub draining_generations: usize,
    pub draining_routes: usize,
    pub idle_age: Option<Duration>,
    pub queued_acquisitions: usize,
    pub last_error: Option<String>,
}

#[async_trait]
pub trait GenerationFactory: Send + Sync {
    async fn start(
        &self,
        generation_id: String,
        domain: IsolationDomainKey,
        revision: ProcessEnvRevision,
        env: HashMap<String, String>,
    ) -> Result<Arc<ServeSupervisor>, String>;

    fn stop(&self, generation: &HostGeneration) -> ShutdownOutcome;
}

pub struct SupervisorGenerationFactory {
    registry: Arc<ServeProcessRegistry>,
    binary_hint: parking_lot::RwLock<Option<String>>,
}

impl SupervisorGenerationFactory {
    pub fn new(registry: Arc<ServeProcessRegistry>) -> Self {
        Self {
            registry,
            binary_hint: parking_lot::RwLock::new(None),
        }
    }

    pub fn set_binary_hint(&self, binary: &str) {
        if !binary.is_empty() && binary != "claude" && binary != "opencode" {
            *self.binary_hint.write() = Some(binary.to_string());
        }
    }
}

#[async_trait]
impl GenerationFactory for SupervisorGenerationFactory {
    async fn start(
        &self,
        generation_id: String,
        _domain: IsolationDomainKey,
        revision: ProcessEnvRevision,
        env: HashMap<String, String>,
    ) -> Result<Arc<ServeSupervisor>, String> {
        let serve = Arc::new(ServeSupervisor::new(
            generation_id,
            Arc::clone(&self.registry),
            env,
            revision,
        ));
        if let Some(binary) = self.binary_hint.read().as_deref() {
            serve.set_binary_hint(binary);
        }
        serve.ensure().await.map_err(|error| error.to_string())?;
        Ok(serve)
    }

    fn stop(&self, generation: &HostGeneration) -> ShutdownOutcome {
        generation.serve.shutdown()
    }
}

#[derive(Default)]
struct DomainState {
    current: Option<Arc<HostGeneration>>,
    draining: Vec<Arc<HostGeneration>>,
    requested_revision: Option<ProcessEnvRevision>,
    last_error: Option<String>,
}

#[derive(Default)]
struct DomainSlot {
    state: parking_lot::Mutex<DomainState>,
    activation_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct CapacityState {
    active: usize,
    next_ticket: u64,
    queue: BTreeSet<u64>,
}

struct CapacityPermit<'a> {
    pool: &'a OpenCodeHostPool,
    committed: bool,
}

enum CapacityReservation<'a> {
    Permit(CapacityPermit<'a>),
    Reused(HostLease),
}

impl CapacityPermit<'_> {
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for CapacityPermit<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.pool.release_capacity();
        }
    }
}

struct QueueTicket<'a> {
    pool: &'a OpenCodeHostPool,
    value: Option<u64>,
}

impl Drop for QueueTicket<'_> {
    fn drop(&mut self) {
        let Some(value) = self.value.take() else {
            return;
        };
        self.pool.capacity.lock().queue.remove(&value);
        self.pool.capacity_changed.notify_waiters();
    }
}

pub struct OpenCodeHostPool {
    factory: Arc<dyn GenerationFactory>,
    domains: parking_lot::Mutex<HashMap<IsolationDomainKey, Arc<DomainSlot>>>,
    capacity: parking_lot::Mutex<CapacityState>,
    capacity_changed: tokio::sync::Notify,
    self_weak: Weak<OpenCodeHostPool>,
}

impl OpenCodeHostPool {
    pub fn new(factory: Arc<dyn GenerationFactory>) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            factory,
            domains: parking_lot::Mutex::new(HashMap::new()),
            capacity: parking_lot::Mutex::new(CapacityState::default()),
            capacity_changed: tokio::sync::Notify::new(),
            self_weak: self_weak.clone(),
        })
    }

    fn slot_for(&self, domain: &IsolationDomainKey) -> Arc<DomainSlot> {
        let mut domains = self.domains.lock();
        Arc::clone(domains.entry(domain.clone()).or_default())
    }

    pub async fn acquire(
        &self,
        domain: IsolationDomainKey,
        revision: ProcessEnvRevision,
        env: HashMap<String, String>,
        deadline: Instant,
    ) -> Result<HostLease, HostPoolError> {
        let slot = self.slot_for(&domain);
        let protected_idle_generation = {
            let _activation = slot.activation_lock.lock().await;
            let mut state = slot.state.lock();
            state.requested_revision = Some(revision.clone());
            if let Some(current) = state.current.clone() {
                if current.process_env_revision == revision
                    && current.lifecycle() == HostLifecycle::Ready
                {
                    state.last_error = None;
                    return Ok(current.reserve_route(self));
                }
            }
            state
                .current
                .as_ref()
                .filter(|current| current.route_count() == 0)
                .map(|current| current.generation_id.clone())
        };

        let mut capacity_permit = match self
            .reserve_capacity(
                &slot,
                &revision,
                deadline,
                protected_idle_generation.as_deref(),
            )
            .await?
        {
            CapacityReservation::Permit(permit) => permit,
            CapacityReservation::Reused(lease) => return Ok(lease),
        };
        let _activation = slot.activation_lock.lock().await;
        {
            let mut state = slot.state.lock();
            state.requested_revision = Some(revision.clone());
            if let Some(current) = state.current.clone() {
                if current.process_env_revision == revision
                    && current.lifecycle() == HostLifecycle::Ready
                {
                    state.last_error = None;
                    return Ok(current.reserve_route(self));
                }
            }
        }

        let generation_id = format!("host-{}", uuid::Uuid::new_v4());
        let start_result = self
            .factory
            .start(generation_id.clone(), domain.clone(), revision.clone(), env)
            .await;
        let serve = match start_result {
            Ok(serve) => serve,
            Err(error) => {
                slot.state.lock().last_error = Some(error.clone());
                return Err(HostPoolError::Spawn(error));
            }
        };
        let generation = Arc::new(HostGeneration::new(generation_id, domain, revision, serve));

        let displaced_without_routes = {
            let mut state = slot.state.lock();
            let displaced = if let Some(old) = state.current.replace(Arc::clone(&generation)) {
                *old.lifecycle.write() = HostLifecycle::Draining;
                if old.route_count() == 0 {
                    Some(old)
                } else {
                    state.draining.push(old);
                    None
                }
            } else {
                None
            };
            state.last_error = None;
            displaced
        };
        self.capacity_changed.notify_waiters();
        if let Some(old) = displaced_without_routes {
            if !self.stop_generation(&old) {
                slot.state.lock().draining.push(old);
            }
        }
        capacity_permit.commit();
        Ok(generation.reserve_route(self))
    }

    async fn reserve_capacity(
        &self,
        slot: &DomainSlot,
        revision: &ProcessEnvRevision,
        deadline: Instant,
        protected_idle_generation: Option<&str>,
    ) -> Result<CapacityReservation<'_>, HostPoolError> {
        let mut ticket = QueueTicket {
            pool: self,
            value: None,
        };
        loop {
            let notified = self.capacity_changed.notified();
            {
                let mut state = slot.state.lock();
                if let Some(current) = state.current.clone() {
                    if current.process_env_revision == *revision
                        && current.lifecycle() == HostLifecycle::Ready
                    {
                        state.last_error = None;
                        return Ok(CapacityReservation::Reused(current.reserve_route(self)));
                    }
                }
            }
            self.evict_one_idle_for_capacity(protected_idle_generation)
                .await;
            {
                let mut capacity = self.capacity.lock();
                let must_queue = capacity.active >= HOST_HARD_LIMIT || !capacity.queue.is_empty();
                if ticket.value.is_none() && must_queue {
                    let assigned = capacity.next_ticket;
                    capacity.next_ticket = capacity.next_ticket.wrapping_add(1);
                    capacity.queue.insert(assigned);
                    ticket.value = Some(assigned);
                }
                let is_head = match ticket.value {
                    Some(assigned) => capacity.queue.first().copied() == Some(assigned),
                    None => capacity.queue.is_empty(),
                };
                if capacity.active < HOST_HARD_LIMIT && is_head {
                    if let Some(assigned) = ticket.value.take() {
                        capacity.queue.remove(&assigned);
                    }
                    capacity.active += 1;
                    self.capacity_changed.notify_waiters();
                    return Ok(CapacityReservation::Permit(CapacityPermit {
                        pool: self,
                        committed: false,
                    }));
                }
            }

            if tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), notified)
                .await
                .is_err()
            {
                let queued = {
                    let mut capacity = self.capacity.lock();
                    if let Some(assigned) = ticket.value.take() {
                        capacity.queue.remove(&assigned);
                    }
                    capacity.queue.len()
                };
                self.capacity_changed.notify_waiters();
                let (active, draining) = self.capacity_counts();
                return Err(HostPoolError::CapacityTimeout {
                    active,
                    draining,
                    queued,
                });
            }
        }
    }

    async fn evict_one_idle_for_capacity(&self, protected_generation: Option<&str>) {
        if self.capacity.lock().active < HOST_SOFT_LIMIT {
            return;
        }
        let Some((_, slot, generation)) = self.oldest_idle_current(protected_generation) else {
            return;
        };
        let _activation = slot.activation_lock.lock().await;
        let removed = {
            let mut state = slot.state.lock();
            let matches = state.current.as_ref().is_some_and(|current| {
                Arc::ptr_eq(current, &generation)
                    && current.route_count() == 0
                    && current.lifecycle() == HostLifecycle::Ready
            });
            matches.then(|| state.current.take().expect("matched current"))
        };
        if let Some(removed) = removed {
            if !self.stop_generation(&removed) {
                slot.state.lock().current = Some(removed);
            }
        }
    }

    fn oldest_idle_current(
        &self,
        protected_generation: Option<&str>,
    ) -> Option<(Instant, Arc<DomainSlot>, Arc<HostGeneration>)> {
        let slots: Vec<Arc<DomainSlot>> = self.domains.lock().values().cloned().collect();
        slots
            .into_iter()
            .filter_map(|slot| {
                let generation = slot.state.lock().current.clone()?;
                if protected_generation == Some(generation.generation_id.as_str())
                    || generation.route_count() != 0
                    || generation.lifecycle() != HostLifecycle::Ready
                {
                    return None;
                }
                let idle_since = (*generation.idle_since.lock())?;
                Some((idle_since, slot, generation))
            })
            .min_by_key(|(idle_since, _, _)| *idle_since)
    }

    fn route_released(&self, generation: Arc<HostGeneration>) {
        let slots: Vec<Arc<DomainSlot>> = self.domains.lock().values().cloned().collect();
        for slot in slots {
            let state = slot.state.lock();
            let belongs_to_slot = state
                .current
                .iter()
                .chain(state.draining.iter())
                .any(|candidate| Arc::ptr_eq(candidate, &generation));
            if !belongs_to_slot {
                continue;
            }
            if generation.lifecycle() == HostLifecycle::Draining {
                drop(state);
                if self.stop_generation(&generation) {
                    slot.state
                        .lock()
                        .draining
                        .retain(|candidate| !Arc::ptr_eq(candidate, &generation));
                }
            } else {
                drop(state);
                self.capacity_changed.notify_waiters();
            }
            return;
        }
    }

    fn stop_generation(&self, generation: &Arc<HostGeneration>) -> bool {
        let _stop = generation.stop_lock.lock();
        if generation.lifecycle() == HostLifecycle::Stopped {
            return true;
        }
        match self.factory.stop(generation) {
            ShutdownOutcome::Idle | ShutdownOutcome::Stopped => {
                *generation.lifecycle.write() = HostLifecycle::Stopped;
                self.release_capacity();
                true
            }
            ShutdownOutcome::Survived { .. } => false,
        }
    }

    fn release_capacity(&self) {
        let mut capacity = self.capacity.lock();
        debug_assert!(capacity.active > 0, "host capacity released more than once");
        capacity.active = capacity.active.saturating_sub(1);
        drop(capacity);
        self.capacity_changed.notify_waiters();
    }

    fn capacity_counts(&self) -> (usize, usize) {
        let active = self.capacity.lock().active;
        let draining = self
            .domains
            .lock()
            .values()
            .map(|slot| slot.state.lock().draining.len())
            .sum();
        (active, draining)
    }

    pub fn stats_for(&self, domain: &IsolationDomainKey) -> DomainHostStats {
        let queued_acquisitions = self.capacity.lock().queue.len();
        let Some(slot) = self.domains.lock().get(domain).cloned() else {
            return DomainHostStats {
                queued_acquisitions,
                ..DomainHostStats::default()
            };
        };
        let state = slot.state.lock();
        let current = state.current.as_ref();
        DomainHostStats {
            current_generation: current.map(|generation| generation.generation_id.clone()),
            current_lifecycle: current.map(|generation| generation.lifecycle()),
            current_revision: current.map(|generation| {
                generation
                    .process_env_revision
                    .diagnostic_prefix()
                    .to_string()
            }),
            requested_revision: state
                .requested_revision
                .as_ref()
                .map(|revision| revision.diagnostic_prefix().to_string()),
            current_routes: current.map_or(0, |generation| generation.route_count()),
            draining_generations: state.draining.len(),
            draining_routes: state
                .draining
                .iter()
                .map(|generation| generation.route_count())
                .sum(),
            idle_age: current
                .and_then(|generation| *generation.idle_since.lock())
                .map(|idle_since| idle_since.elapsed()),
            queued_acquisitions,
            last_error: state.last_error.clone(),
        }
    }

    pub fn host_count(&self) -> usize {
        self.capacity.lock().active
    }

    pub async fn evict_idle(&self, now: Instant) {
        loop {
            let Some((idle_since, slot, generation)) = self.oldest_idle_current(None) else {
                return;
            };
            if now.saturating_duration_since(idle_since) < HOST_IDLE_TTL {
                return;
            }
            let _activation = slot.activation_lock.lock().await;
            let removed = {
                let mut state = slot.state.lock();
                let matches = state.current.as_ref().is_some_and(|current| {
                    Arc::ptr_eq(current, &generation)
                        && current.route_count() == 0
                        && current.lifecycle() == HostLifecycle::Ready
                        && current.idle_since.lock().is_some_and(|idle| {
                            now.saturating_duration_since(idle) >= HOST_IDLE_TTL
                        })
                });
                matches.then(|| state.current.take().expect("matched current"))
            };
            if let Some(removed) = removed {
                if !self.stop_generation(&removed) {
                    slot.state.lock().current = Some(removed);
                    return;
                }
            }
        }
    }

    pub async fn shutdown_all(&self) {
        let slots: Vec<Arc<DomainSlot>> = self.domains.lock().values().cloned().collect();
        for slot in slots {
            let _activation = slot.activation_lock.lock().await;
            let generations = {
                let mut state = slot.state.lock();
                state
                    .current
                    .take()
                    .into_iter()
                    .chain(state.draining.drain(..))
                    .collect::<Vec<_>>()
            };
            for generation in generations {
                if !self.stop_generation(&generation) {
                    slot.state.lock().draining.push(generation);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use async_trait::async_trait;
    use parking_lot::Mutex;

    use super::*;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
    use crate::runtime::opencode_http::process_registry::ServeProcessRegistry;
    use crate::runtime::opencode_http::supervisor::ServeSupervisor;

    struct FakeGenerationFactory {
        registry: Arc<ServeProcessRegistry>,
        starts: AtomicUsize,
        stops: Mutex<Vec<String>>,
        start_order: Mutex<Vec<IsolationDomainKey>>,
        fail_next: AtomicBool,
        block_next: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        survive_next_stop: AtomicBool,
    }

    impl FakeGenerationFactory {
        fn new() -> Arc<Self> {
            let directory = tempfile::tempdir().expect("temp registry directory");
            let registry_path = directory.keep().join("opencode-pgids.json");
            Arc::new(Self {
                registry: Arc::new(ServeProcessRegistry::new(registry_path)),
                starts: AtomicUsize::new(0),
                stops: Mutex::new(Vec::new()),
                start_order: Mutex::new(Vec::new()),
                fail_next: AtomicBool::new(false),
                block_next: Mutex::new(None),
                survive_next_stop: AtomicBool::new(false),
            })
        }

        fn start_count(&self) -> usize {
            self.starts.load(Ordering::SeqCst)
        }

        fn stopped(&self) -> Vec<String> {
            self.stops.lock().clone()
        }

        fn block_next_start(&self) -> Arc<tokio::sync::Semaphore> {
            let gate = Arc::new(tokio::sync::Semaphore::new(0));
            *self.block_next.lock() = Some(Arc::clone(&gate));
            gate
        }
    }

    #[async_trait]
    impl GenerationFactory for FakeGenerationFactory {
        async fn start(
            &self,
            generation_id: String,
            domain: IsolationDomainKey,
            revision: ProcessEnvRevision,
            env: HashMap<String, String>,
        ) -> Result<Arc<ServeSupervisor>, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.start_order.lock().push(domain);
            let gate = self.block_next.lock().take();
            if let Some(gate) = gate {
                gate.acquire()
                    .await
                    .expect("fake start gate must remain open")
                    .forget();
            }
            if self.fail_next.swap(false, Ordering::SeqCst) {
                return Err("fake health failure".to_string());
            }
            Ok(Arc::new(ServeSupervisor::new(
                generation_id,
                Arc::clone(&self.registry),
                env,
                revision,
            )))
        }

        fn stop(&self, generation: &HostGeneration) -> ShutdownOutcome {
            if self.survive_next_stop.swap(false, Ordering::SeqCst) {
                ShutdownOutcome::Survived { pgid: 41001 }
            } else {
                self.stops.lock().push(generation.generation_id.clone());
                ShutdownOutcome::Stopped
            }
        }
    }

    fn domain(name: &str) -> IsolationDomainKey {
        IsolationDomainKey::Workspace(name.to_string())
    }

    fn revision(value: &str) -> ProcessEnvRevision {
        ProcessEnvRevision::from_bindings(&HashMap::from([(
            "SENTINEL".to_string(),
            value.to_string(),
        )]))
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    async fn wait_for_queue(pool: &OpenCodeHostPool, domain: &IsolationDomainKey, size: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if pool.stats_for(domain).queued_acquisitions == size {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("capacity waiter should enqueue");
    }

    #[tokio::test]
    async fn same_domain_and_revision_reuses_one_generation() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());

        let first = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let second = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        assert!(Arc::ptr_eq(&first.generation, &second.generation));
        assert_eq!(first.generation.route_count(), 2);
        assert_eq!(factory.start_count(), 1);
    }

    #[tokio::test]
    async fn different_domains_create_independent_generations() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());

        let a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        assert_ne!(a.generation.generation_id, b.generation.generation_id);
        assert_eq!(factory.start_count(), 2);
    }

    #[tokio::test]
    async fn revision_change_without_routes_stops_and_replaces_current() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let old = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let old_id = old.generation.generation_id.clone();
        drop(old);

        let new = pool
            .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
            .await
            .unwrap();

        assert_ne!(new.generation.generation_id, old_id);
        assert_eq!(factory.stopped(), vec![old_id]);
        assert_eq!(new.generation.lifecycle(), HostLifecycle::Ready);
    }

    #[tokio::test]
    async fn failed_idle_replacement_keeps_old_current_ready() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let old = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let old_generation = Arc::clone(&old.generation);
        drop(old);
        factory.fail_next.store(true, Ordering::SeqCst);

        let error = pool
            .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
            .await
            .unwrap_err();

        assert!(matches!(error, HostPoolError::Spawn(_)));
        assert_eq!(
            pool.stats_for(&domain("a")).current_generation.as_deref(),
            Some(old_generation.generation_id.as_str())
        );
        assert_eq!(old_generation.lifecycle(), HostLifecycle::Ready);
        assert!(factory.stopped().is_empty());
    }

    #[tokio::test]
    async fn active_revision_change_rolls_only_after_new_generation_is_healthy() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let old = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        factory.fail_next.store(true, Ordering::SeqCst);

        let error = pool
            .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
            .await
            .unwrap_err();
        assert!(matches!(error, HostPoolError::Spawn(_)));
        assert_eq!(
            pool.stats_for(&domain("a")).current_generation.as_deref(),
            Some(old.generation.generation_id.as_str())
        );
        assert_eq!(old.generation.lifecycle(), HostLifecycle::Ready);

        let new = pool
            .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
            .await
            .unwrap();
        assert_eq!(new.generation.lifecycle(), HostLifecycle::Ready);
        assert_eq!(old.generation.lifecycle(), HostLifecycle::Draining);
        assert_eq!(old.generation.route_count(), 1);
        assert_eq!(pool.stats_for(&domain("a")).draining_generations, 1);
    }

    #[tokio::test]
    async fn final_old_route_release_stops_draining_generation() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let old = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let old_id = old.generation.generation_id.clone();
        let _new = pool
            .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
            .await
            .unwrap();

        drop(old);

        assert_eq!(factory.stopped(), vec![old_id]);
        assert_eq!(pool.stats_for(&domain("a")).draining_generations, 0);
    }

    #[tokio::test]
    async fn old_route_dropped_during_replacement_start_is_stopped_on_publish() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let old = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let old_generation = Arc::clone(&old.generation);
        let gate = factory.block_next_start();

        let replacement_pool = Arc::clone(&pool);
        let replacement = tokio::spawn(async move {
            replacement_pool
                .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while factory.start_count() < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("replacement start should block in the fake factory");
        drop(old);
        gate.add_permits(1);

        let new = replacement.await.unwrap().unwrap();

        assert_eq!(new.generation.lifecycle(), HostLifecycle::Ready);
        assert_eq!(old_generation.lifecycle(), HostLifecycle::Stopped);
        assert_eq!(pool.stats_for(&domain("a")).draining_generations, 0);
        assert_eq!(
            factory.stopped(),
            vec![old_generation.generation_id.clone()]
        );
    }

    #[tokio::test]
    async fn idle_lru_generation_is_evicted_before_spawning_over_soft_limit() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let a_id = a.generation.generation_id.clone();
        drop(a);
        tokio::time::sleep(Duration::from_millis(2)).await;
        let b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        drop(b);

        let _c = pool
            .acquire(domain("c"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        assert_eq!(factory.stopped(), vec![a_id]);
        assert_eq!(factory.start_count(), 3);
    }

    #[tokio::test]
    async fn hard_limit_waiters_are_fifo_and_never_evict_active_generations() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _c = pool
            .acquire(domain("c"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        let first_pool = Arc::clone(&pool);
        let first = tokio::spawn(async move {
            first_pool
                .acquire(domain("d"), revision("1"), HashMap::new(), deadline())
                .await
        });
        wait_for_queue(&pool, &domain("d"), 1).await;
        let second_pool = Arc::clone(&pool);
        let second = tokio::spawn(async move {
            second_pool
                .acquire(domain("e"), revision("1"), HashMap::new(), deadline())
                .await
        });
        wait_for_queue(&pool, &domain("e"), 2).await;
        assert!(factory.stopped().is_empty());

        drop(a);
        let d = tokio::time::timeout(Duration::from_secs(2), first)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!second.is_finished(), "second ticket must remain queued");
        drop(d);
        let _e = tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        let order = factory.start_order.lock().clone();
        assert_eq!(&order[3..], &[domain("d"), domain("e")]);
    }

    #[tokio::test]
    async fn same_domain_capacity_waiters_reuse_the_generation_published_by_the_head() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _c = pool
            .acquire(domain("c"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        let first_pool = Arc::clone(&pool);
        let first = tokio::spawn(async move {
            first_pool
                .acquire(domain("d"), revision("1"), HashMap::new(), deadline())
                .await
        });
        wait_for_queue(&pool, &domain("d"), 1).await;
        let second_pool = Arc::clone(&pool);
        let second = tokio::spawn(async move {
            second_pool
                .acquire(domain("d"), revision("1"), HashMap::new(), deadline())
                .await
        });
        wait_for_queue(&pool, &domain("d"), 2).await;

        drop(a);

        let first = tokio::time::timeout(Duration::from_secs(2), first)
            .await
            .expect("head waiter should acquire the freed capacity")
            .unwrap()
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .expect("peer waiter should attach after the head publishes")
            .unwrap()
            .unwrap();

        assert_eq!(factory.start_count(), 4, "only one new host should spawn");
        assert_eq!(
            first.generation.generation_id,
            second.generation.generation_id
        );
    }

    #[tokio::test]
    async fn same_domain_capacity_wait_can_evict_its_newly_idle_current() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory);
        let a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _c = pool
            .acquire(domain("c"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        let replacement_pool = Arc::clone(&pool);
        let replacement = tokio::spawn(async move {
            replacement_pool
                .acquire(domain("a"), revision("2"), HashMap::new(), deadline())
                .await
        });
        wait_for_queue(&pool, &domain("a"), 1).await;
        drop(a);

        let acquired = tokio::time::timeout(Duration::from_secs(2), replacement)
            .await
            .expect("same-domain capacity waiter must not deadlock")
            .unwrap()
            .unwrap();

        assert_eq!(
            acquired.generation.process_env_revision,
            revision("2"),
            "replacement should complete after evicting the idle old current"
        );
    }

    #[tokio::test]
    async fn surviving_stopped_group_keeps_capacity_at_hard_limit() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _c = pool
            .acquire(domain("c"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        drop(a);
        factory.survive_next_stop.store(true, Ordering::SeqCst);

        let error = pool
            .acquire(
                domain("d"),
                revision("1"),
                HashMap::new(),
                Instant::now() + Duration::from_millis(50),
            )
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            HostPoolError::CapacityTimeout { active: 3, .. }
        ));
        assert_eq!(
            factory.start_count(),
            3,
            "a surviving process group must block a fourth spawn"
        );
    }

    #[tokio::test]
    async fn capacity_deadline_returns_observable_timeout_counts() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory);
        let _a = pool
            .acquire(domain("a"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _b = pool
            .acquire(domain("b"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();
        let _c = pool
            .acquire(domain("c"), revision("1"), HashMap::new(), deadline())
            .await
            .unwrap();

        let error = pool
            .acquire(
                domain("d"),
                revision("1"),
                HashMap::new(),
                Instant::now() + Duration::from_millis(20),
            )
            .await
            .unwrap_err();

        assert_eq!(
            error,
            HostPoolError::CapacityTimeout {
                active: 3,
                draining: 0,
                queued: 0,
            }
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_same_revision_acquires_spawn_exactly_once() {
        let factory = FakeGenerationFactory::new();
        let pool = OpenCodeHostPool::new(factory.clone());
        let barrier = Arc::new(tokio::sync::Barrier::new(100));
        let mut tasks = Vec::new();
        for _ in 0..100 {
            let pool = Arc::clone(&pool);
            let barrier = Arc::clone(&barrier);
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                pool.acquire(domain("a"), revision("1"), HashMap::new(), deadline())
                    .await
                    .unwrap()
            }));
        }
        let mut leases = Vec::new();
        for task in tasks {
            leases.push(task.await.unwrap());
        }

        assert_eq!(factory.start_count(), 1);
        assert!(leases
            .iter()
            .all(|lease| Arc::ptr_eq(&lease.generation, &leases[0].generation)));
        assert_eq!(leases[0].generation.route_count(), 100);
    }
}
