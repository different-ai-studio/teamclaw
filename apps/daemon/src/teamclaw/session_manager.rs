use crate::mqtt::Topics;
use crate::proto::teamclaw::{self, RpcRequest, RpcResponse};
use crate::teamclaw::{
    IdeaStore, LivePublisher, MessageStore, NotifyPublisher, RpcServer, StoredClaim, StoredIdea,
    StoredMessage, StoredParticipant, StoredSession, StoredSubmission, TeamclawSessionStore,
};
use chrono::Utc;
use rumqttc::{AsyncClient, QoS};
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::path::PathBuf;
use tracing::{info, warn};
use uuid::Uuid;

const RECENT_EVENT_CACHE_LIMIT: usize = 512;

pub struct SessionManager {
    topics: Topics,
    client: AsyncClient,
    live_publisher: LivePublisher,
    notify_publisher: NotifyPublisher,
    rpc_server: RpcServer,
    pub(crate) sessions: TeamclawSessionStore,
    sessions_path: PathBuf,
    pub(crate) config_dir: PathBuf,
    device_id: String,
    team_id: String,
    actor_id: Option<String>,
    recent_event_keys: HashSet<String>,
    recent_event_order: VecDeque<String>,
    subscribed_live_sessions: BTreeSet<String>,
    #[cfg(test)]
    skip_live_subscription_io: bool,
}

impl SessionManager {
    pub fn new(
        client: AsyncClient,
        team_id: &str,
        device_id: &str,
        actor_id: Option<String>,
        config_dir: PathBuf,
    ) -> crate::error::Result<Self> {
        let topics = Topics::new(team_id, device_id);
        let live_publisher =
            LivePublisher::new(client.clone(), team_id.to_string(), device_id.to_string());
        let notify_publisher = NotifyPublisher::new(client.clone(), team_id.to_string());
        let rpc_server = RpcServer::new(client.clone(), team_id.to_string(), device_id.to_string());
        let sessions_path = TeamclawSessionStore::default_path(&config_dir);
        let sessions = TeamclawSessionStore::load(&sessions_path)?;

        Ok(Self {
            topics,
            client,
            live_publisher,
            notify_publisher,
            rpc_server,
            sessions,
            sessions_path,
            config_dir,
            device_id: device_id.to_string(),
            team_id: team_id.to_string(),
            actor_id,
            recent_event_keys: HashSet::new(),
            recent_event_order: VecDeque::new(),
            subscribed_live_sessions: BTreeSet::new(),
            #[cfg(test)]
            skip_live_subscription_io: false,
        })
    }

    /// Subscribe to all relevant teamclaw topics.
    pub async fn subscribe_all(&mut self) -> crate::error::Result<()> {
        for topic in self.base_subscription_topics() {
            self.client.subscribe(topic, QoS::AtLeastOnce).await?;
        }
        self.refresh_membership_subscriptions().await?;

        Ok(())
    }

    /// Handle a pre-parsed RPC request. Only dispatches session/idea-scoped methods.
    ///
    /// Caller is responsible for decoding the wire payload and publishing the response.
    /// Non-session methods are dispatched by `DaemonServer::handle_rpc_request` directly.
    ///
    /// `host_primary_agent_id` is intentionally ignored for session creation.
    /// A session should only gain `primary_agent_id` once an agent actually
    /// joins it, rather than inheriting whichever local agent happened to be
    /// running when the session was created.
    pub async fn handle_rpc_method(
        &mut self,
        request: RpcRequest,
        primary_agent_id: Option<String>,
    ) -> RpcResponse {
        let request_id = request.request_id.clone();
        match request.method.clone() {
            Some(teamclaw::rpc_request::Method::CreateSession(r)) => {
                self.handle_create_session(&request, r, primary_agent_id)
                    .await
            }
            Some(teamclaw::rpc_request::Method::FetchSession(r)) => {
                self.handle_fetch_session(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::FetchSessionMessages(r)) => {
                self.handle_fetch_session_messages(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::JoinSession(r)) => {
                self.handle_join_session(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::AddParticipant(r)) => {
                self.handle_add_participant(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::RemoveParticipant(r)) => {
                self.handle_remove_participant(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::CreateIdea(r)) => {
                self.handle_create_idea(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::ClaimIdea(r)) => {
                self.handle_claim_idea(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::SubmitIdea(r)) => {
                self.handle_submit_idea(&request, r).await
            }
            Some(teamclaw::rpc_request::Method::UpdateIdea(r)) => {
                self.handle_update_idea(&request, r).await
            }
            other => {
                // Non-session methods are dispatched by DaemonServer directly,
                // not SessionManager. If we land here, the caller routed wrong.
                warn!(
                    ?other,
                    "SessionManager got non-session RPC method; routing bug"
                );
                RpcResponse {
                    request_id,
                    success: false,
                    error: "method not handled by SessionManager".to_string(),
                    requester_client_id: request.requester_client_id,
                    requester_actor_id: request.requester_actor_id,
                    requester_device_id: request.requester_device_id,
                    result: None,
                }
            }
        }
    }

    // --- RPC Handlers ---

    async fn handle_create_session(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::CreateSessionRequest,
        _host_primary_agent_id: Option<String>,
    ) -> RpcResponse {
        let session_id = Uuid::new_v4().to_string();

        let session = StoredSession {
            session_id: session_id.clone(),
            team_id: r.team_id.clone(),
            title: r.title.clone(),
            created_by: if !r.sender_actor_id.is_empty() {
                r.sender_actor_id.clone()
            } else {
                req.sender_device_id.clone()
            },
            created_at: Utc::now(),
            summary: r.summary.clone(),
            idea_id: r.idea_id.clone(),
            participants: vec![],
            primary_agent_id: String::new(),
        };

        self.sessions.upsert(session);
        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_create_session: failed to save sessions: {}", e);
        }

        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %session_id,
                "handle_create_session: failed to refresh membership subscriptions: {}",
                e
            );
        }

        let session_info = self.sessions.to_proto_session_info(&session_id);
        info!(session_id = %session_id, "session created");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: session_info.map(|s| teamclaw::rpc_response::Result::SessionInfo(s)),
        }
    }

    async fn handle_fetch_session(
        &self,
        req: &RpcRequest,
        r: teamclaw::FetchSessionRequest,
    ) -> RpcResponse {
        match self.sessions.to_proto_session_info(&r.session_id) {
            Some(info) => RpcResponse {
                request_id: req.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                requester_device_id: String::new(),
                result: Some(teamclaw::rpc_response::Result::SessionInfo(info)),
            },
            None => RpcResponse {
                request_id: req.request_id.clone(),
                success: false,
                error: format!("session {} not found", r.session_id),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                requester_device_id: String::new(),
                result: None,
            },
        }
    }

    async fn handle_fetch_session_messages(
        &self,
        req: &RpcRequest,
        r: teamclaw::FetchSessionMessagesRequest,
    ) -> RpcResponse {
        let store = match MessageStore::load(&self.config_dir, &r.session_id) {
            Ok(store) => store,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        let (messages, has_more, next_before_created_at) = store.page_before(
            r.before_created_at,
            if r.page_size == 0 { 100 } else { r.page_size },
        );
        let page = teamclaw::SessionMessagePage {
            session_id: r.session_id,
            messages: messages.into_iter().map(MessageStore::to_proto).collect(),
            has_more,
            next_before_created_at,
        };

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: Some(teamclaw::rpc_response::Result::SessionMessagePage(page)),
        }
    }

    async fn handle_join_session(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::JoinSessionRequest,
    ) -> RpcResponse {
        let participant = match r.participant {
            Some(p) => p,
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: "missing participant".to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        let actor_type = actor_type_to_string(participant.actor_type);
        let proto_participant = participant.clone();
        let stored_participant = StoredParticipant {
            actor_id: participant.actor_id.clone(),
            actor_type,
            display_name: participant.display_name.clone(),
            joined_at: Utc::now(),
        };

        match self.sessions.find_by_id_mut(&r.session_id) {
            Some(session) => {
                // Only add if not already a participant
                if !session
                    .participants
                    .iter()
                    .any(|p| p.actor_id == participant.actor_id)
                {
                    session.participants.push(stored_participant);
                }
                if participant_is_agent(participant.actor_type)
                    && session.primary_agent_id.is_empty()
                {
                    session.primary_agent_id = participant.actor_id.clone();
                }
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("session {} not found", r.session_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        }

        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_join_session: failed to save sessions: {}", e);
        }
        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %r.session_id,
                "handle_join_session: failed to refresh membership subscriptions: {}",
                e
            );
        }
        if let Err(e) = self
            .live_publisher
            .publish_presence_event("presence.joined", &r.session_id, &proto_participant)
            .await
        {
            warn!(
                "handle_join_session: failed to publish live presence event: {}",
                e
            );
        }
        for target_device_id in
            self.membership_refresh_targets(&r.session_id, Some(&req.sender_device_id))
        {
            if let Err(e) = self
                .notify_publisher
                .publish_membership_refresh(&target_device_id, &r.session_id, "participant_joined")
                .await
            {
                warn!(
                    target_device_id = %target_device_id,
                    "handle_join_session: failed to publish notify event: {}",
                    e
                );
            }
        }

        let session_info = self.sessions.to_proto_session_info(&r.session_id);
        info!(session_id = %r.session_id, actor_id = %participant.actor_id, "participant joined session");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: session_info.map(|s| teamclaw::rpc_response::Result::SessionInfo(s)),
        }
    }

    async fn handle_add_participant(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::AddParticipantRequest,
    ) -> RpcResponse {
        let participant = match r.participant {
            Some(p) => p,
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: "missing participant".to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        let actor_type = actor_type_to_string(participant.actor_type);
        let proto_participant = participant.clone();
        let stored_participant = StoredParticipant {
            actor_id: participant.actor_id.clone(),
            actor_type,
            display_name: participant.display_name.clone(),
            joined_at: Utc::now(),
        };

        match self.sessions.find_by_id_mut(&r.session_id) {
            Some(session) => {
                if !session
                    .participants
                    .iter()
                    .any(|p| p.actor_id == participant.actor_id)
                {
                    session.participants.push(stored_participant);
                }
                if participant_is_agent(participant.actor_type)
                    && session.primary_agent_id.is_empty()
                {
                    session.primary_agent_id = participant.actor_id.clone();
                }
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("session {} not found", r.session_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        }

        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_add_participant: failed to save sessions: {}", e);
        }
        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %r.session_id,
                "handle_add_participant: failed to refresh membership subscriptions: {}",
                e
            );
        }
        if let Err(e) = self
            .live_publisher
            .publish_presence_event("presence.joined", &r.session_id, &proto_participant)
            .await
        {
            warn!(
                "handle_add_participant: failed to publish live presence event: {}",
                e
            );
        }
        for target_device_id in
            self.membership_refresh_targets(&r.session_id, Some(&req.sender_device_id))
        {
            if let Err(e) = self
                .notify_publisher
                .publish_membership_refresh(&target_device_id, &r.session_id, "participant_added")
                .await
            {
                warn!(
                    target_device_id = %target_device_id,
                    "handle_add_participant: failed to publish notify event: {}",
                    e
                );
            }
        }

        let session_info = self.sessions.to_proto_session_info(&r.session_id);
        info!(session_id = %r.session_id, actor_id = %participant.actor_id, "participant added to session");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: session_info.map(|s| teamclaw::rpc_response::Result::SessionInfo(s)),
        }
    }

    async fn handle_remove_participant(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::RemoveParticipantRequest,
    ) -> RpcResponse {
        let removed_participant = match self.sessions.find_by_id_mut(&r.session_id) {
            Some(session) => {
                let removed = session
                    .participants
                    .iter()
                    .find(|p| p.actor_id == r.actor_id)
                    .cloned();
                session.participants.retain(|p| p.actor_id != r.actor_id);
                removed
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("session {} not found", r.session_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!("handle_remove_participant: failed to save sessions: {}", e);
        }
        if let Err(e) = self.refresh_membership_subscriptions().await {
            warn!(
                session_id = %r.session_id,
                "handle_remove_participant: failed to refresh membership subscriptions: {}",
                e
            );
        }
        if let Some(participant) = removed_participant.as_ref() {
            let proto_participant = stored_participant_to_proto(participant);
            if let Err(e) = self
                .live_publisher
                .publish_presence_event("presence.left", &r.session_id, &proto_participant)
                .await
            {
                warn!(
                    "handle_remove_participant: failed to publish live presence event: {}",
                    e
                );
            }
        }
        for target_device_id in
            self.membership_refresh_targets(&r.session_id, Some(&req.sender_device_id))
        {
            if let Err(e) = self
                .notify_publisher
                .publish_membership_refresh(&target_device_id, &r.session_id, "participant_removed")
                .await
            {
                warn!(
                    target_device_id = %target_device_id,
                    "handle_remove_participant: failed to publish notify event: {}",
                    e
                );
            }
        }

        let session_info = self.sessions.to_proto_session_info(&r.session_id);
        info!(session_id = %r.session_id, actor_id = %r.actor_id, "participant removed from session");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: session_info.map(|s| teamclaw::rpc_response::Result::SessionInfo(s)),
        }
    }

    /// Synthesise a local `StoredSession` from a Supabase fetch, populate
    /// participants, and trigger a `refresh_membership_subscriptions` so the
    /// daemon subscribes to `session/{sid}/live` if it is a participant.
    ///
    /// iOS creates collab sessions by writing directly to Supabase
    /// `sessions`/`session_participants`; the daemon only learns about them
    /// via this path (called from `apply_start_runtime`). Without this,
    /// inbound `message.created` events on `session/{sid}/live` are silently
    /// dropped because the daemon never subscribed.
    ///
    /// `session_participants` doesn't carry an explicit actor_type. We stamp
    /// the local daemon actor as `personal_agent` (which it is — the daemon
    /// owns the device's primary agent), and other participants as
    /// `unknown` until a richer source of truth is wired through. This is
    /// load-bearing for `agents_to_activate`, which only routes messages to
    /// participants whose stored actor_type is `personal_agent` or
    /// `role_agent`.
    pub async fn insert_session_from_supabase(
        &mut self,
        session: &crate::supabase::SupabaseSessionRow,
        participants: &[crate::supabase::SupabaseParticipantRow],
    ) -> crate::error::Result<()> {
        let local_actor_id = self.actor_id.as_deref();
        let stored_participants: Vec<StoredParticipant> = participants
            .iter()
            .map(|p| {
                let actor_type = if local_actor_id.is_some_and(|a| a == p.actor_id) {
                    "personal_agent"
                } else {
                    "unknown"
                };
                StoredParticipant {
                    actor_id: p.actor_id.clone(),
                    actor_type: actor_type.to_string(),
                    display_name: String::new(),
                    joined_at: p.joined_at,
                }
            })
            .collect();

        let stored = StoredSession {
            session_id: session.id.clone(),
            team_id: session.team_id.clone(),
            title: session.title.clone(),
            created_by: session.created_by_actor_id.clone().unwrap_or_default(),
            created_at: session.created_at,
            summary: session.summary.clone(),
            idea_id: session.idea_id.clone().unwrap_or_default(),
            participants: stored_participants,
            primary_agent_id: session.primary_agent_id.clone().unwrap_or_default(),
        };

        self.sessions.upsert(stored);
        if let Err(e) = self.sessions.save(&self.sessions_path) {
            warn!(
                "insert_session_from_supabase: failed to save sessions: {}",
                e
            );
        }

        self.refresh_membership_subscriptions().await?;
        info!(
            session_id = %session.id,
            "inserted Supabase-sourced session into teamclaw cache"
        );
        Ok(())
    }

    #[cfg(test)]
    pub async fn insert_session_from_supabase_for_test(
        &mut self,
        session_id: &str,
        team_id: &str,
        primary_agent_id: Option<&str>,
        participants: &[(&str, &str)],
    ) -> crate::error::Result<()> {
        use crate::supabase::{SupabaseParticipantRow, SupabaseSessionRow};
        let session = SupabaseSessionRow {
            id: session_id.into(),
            team_id: team_id.into(),
            created_by_actor_id: None,
            primary_agent_id: primary_agent_id.map(String::from),
            mode: "collab".into(),
            title: String::new(),
            summary: String::new(),
            idea_id: None,
            created_at: chrono::Utc::now(),
        };
        let now = chrono::Utc::now();
        let parts: Vec<SupabaseParticipantRow> = participants
            .iter()
            .map(|(actor, role)| SupabaseParticipantRow {
                session_id: session_id.into(),
                actor_id: (*actor).into(),
                role: Some((*role).into()),
                joined_at: now,
            })
            .collect();
        self.insert_session_from_supabase(&session, &parts).await
    }

    async fn handle_create_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::CreateIdeaRequest,
    ) -> RpcResponse {
        let idea_id = Uuid::new_v4().to_string();
        // Prefer the sender's actor/member id when the client supplies it.
        // Older clients that only set sender_device_id still work, they'll
        // just render as "Unknown" on the current UI.
        let created_by = if !r.sender_actor_id.is_empty() {
            r.sender_actor_id.clone()
        } else {
            req.sender_device_id.clone()
        };
        let stored_item = StoredIdea {
            idea_id: idea_id.clone(),
            session_id: r.session_id.clone(),
            workspace_id: r.workspace_id.clone(),
            title: r.title.clone(),
            description: r.description.clone(),
            status: "open".to_string(),
            parent_id: r.parent_id.clone(),
            created_by,
            created_at: Utc::now(),
            archived: false,
        };

        let store_key = canonical_idea_store_key(&r.session_id);

        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                warn!("handle_create_idea: failed to load idea store: {}", e);
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        store.add_item(stored_item);

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_create_idea: failed to save idea store: {}", e);
        }

        let idea = store.find_item(&idea_id).map(|i| store.to_proto_idea(i));

        // Publish IdeaEvent
        if let Some(ref item) = idea {
            let event = teamclaw::IdeaEvent {
                event: Some(teamclaw::idea_event::Event::Created(item.clone())),
            };
            if !r.session_id.is_empty() {
                if let Err(e) = self
                    .live_publisher
                    .publish_idea_event("idea.created", &r.session_id, &item.created_by, &event)
                    .await
                {
                    warn!(
                        "handle_create_idea: failed to publish live idea event: {}",
                        e
                    );
                }
            }
        }

        info!(idea_id = %idea_id, session_id = %r.session_id, "idea created");

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: idea.map(|t| teamclaw::rpc_response::Result::Idea(t)),
        }
    }

    async fn handle_claim_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::ClaimIdeaRequest,
    ) -> RpcResponse {
        let store_key = canonical_idea_store_key(&r.session_id);
        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        let claim_id = Uuid::new_v4().to_string();
        let actor_id = if !r.sender_actor_id.is_empty() {
            r.sender_actor_id.clone()
        } else {
            req.sender_device_id.clone()
        };
        let claim = StoredClaim {
            claim_id: claim_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            claimed_at: Utc::now(),
        };

        store.add_claim(claim);

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_claim_idea: failed to save idea store: {}", e);
        }

        let proto_claim = teamclaw::Claim {
            claim_id: claim_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            claimed_at: Utc::now().timestamp(),
        };

        // Publish IdeaEvent
        let event = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Claimed(proto_claim.clone())),
        };
        if !r.session_id.is_empty() {
            if let Err(e) = self
                .live_publisher
                .publish_idea_event("idea.updated", &r.session_id, &proto_claim.actor_id, &event)
                .await
            {
                warn!(
                    "handle_claim_idea: failed to publish live claim event: {}",
                    e
                );
            }
        }

        info!(
            claim_id = %claim_id,
            idea_id = %r.idea_id,
            session_id = %r.session_id,
            "idea claimed"
        );

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: Some(teamclaw::rpc_response::Result::Claim(proto_claim)),
        }
    }

    async fn handle_submit_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::SubmitIdeaRequest,
    ) -> RpcResponse {
        let store_key = canonical_idea_store_key(&r.session_id);
        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        let submission_id = Uuid::new_v4().to_string();
        let actor_id = if !r.sender_actor_id.is_empty() {
            r.sender_actor_id.clone()
        } else {
            req.sender_device_id.clone()
        };
        let submission = StoredSubmission {
            submission_id: submission_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            content: r.content.clone(),
            submitted_at: Utc::now(),
        };

        store.add_submission(submission);

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_submit_idea: failed to save idea store: {}", e);
        }

        let proto_submission = teamclaw::Submission {
            submission_id: submission_id.clone(),
            idea_id: r.idea_id.clone(),
            actor_id: actor_id.clone(),
            content: r.content.clone(),
            submitted_at: Utc::now().timestamp(),
        };

        // Publish IdeaEvent
        let event = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Submitted(
                proto_submission.clone(),
            )),
        };
        if !r.session_id.is_empty() {
            if let Err(e) = self
                .live_publisher
                .publish_idea_event(
                    "idea.updated",
                    &r.session_id,
                    &proto_submission.actor_id,
                    &event,
                )
                .await
            {
                warn!(
                    "handle_submit_idea: failed to publish live submission event: {}",
                    e
                );
            }
        }

        info!(
            submission_id = %submission_id,
            idea_id = %r.idea_id,
            session_id = %r.session_id,
            "idea submitted"
        );

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: Some(teamclaw::rpc_response::Result::Submission(proto_submission)),
        }
    }

    async fn handle_update_idea(
        &mut self,
        req: &RpcRequest,
        r: teamclaw::UpdateIdeaRequest,
    ) -> RpcResponse {
        let store_key = if r.session_id.is_empty() {
            "global"
        } else {
            &r.session_id
        };

        let mut store = match IdeaStore::load(&self.config_dir, store_key) {
            Ok(s) => s,
            Err(e) => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: e.to_string(),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        };

        match store.find_item_mut(&r.idea_id) {
            Some(item) => {
                if !r.title.is_empty() {
                    item.title = r.title.clone();
                }
                if !r.description.is_empty() {
                    item.description = r.description.clone();
                }
                // Update status if non-zero (unknown is 0)
                if r.status != 0 {
                    item.status = idea_status_to_string(r.status);
                }
                if let Some(v) = r.archived {
                    item.archived = v;
                }
            }
            None => {
                return RpcResponse {
                    request_id: req.request_id.clone(),
                    success: false,
                    error: format!("idea {} not found", r.idea_id),
                    requester_client_id: String::new(),
                    requester_actor_id: String::new(),
                    requester_device_id: String::new(),
                    result: None,
                };
            }
        }

        if let Err(e) = store.save(&self.config_dir, store_key) {
            warn!("handle_update_idea: failed to save idea store: {}", e);
        }

        let idea = store.find_item(&r.idea_id).map(|i| store.to_proto_idea(i));

        // Publish IdeaEvent
        if let Some(ref item) = idea {
            let event = teamclaw::IdeaEvent {
                event: Some(teamclaw::idea_event::Event::Updated(item.clone())),
            };
            if !r.session_id.is_empty() {
                if let Err(e) = self
                    .live_publisher
                    .publish_idea_event(
                        "idea.updated",
                        &r.session_id,
                        &req.sender_device_id,
                        &event,
                    )
                    .await
                {
                    warn!(
                        "handle_update_idea: failed to publish live update event: {}",
                        e
                    );
                }
            }
        }

        info!(
            idea_id = %r.idea_id,
            session_id = %r.session_id,
            archived = ?r.archived,
            "idea updated"
        );

        RpcResponse {
            request_id: req.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            result: idea.map(|t| teamclaw::rpc_response::Result::Idea(t)),
        }
    }

    // --- Public helpers ---

    /// Persist an incoming message for a session.
    pub async fn persist_message(
        &self,
        session_id: &str,
        message: &teamclaw::Message,
    ) -> crate::error::Result<()> {
        let stored = StoredMessage {
            message_id: message.message_id.clone(),
            session_id: message.session_id.clone(),
            sender_actor_id: message.sender_actor_id.clone(),
            kind: message_kind_to_string(message.kind),
            content: message.content.clone(),
            created_at: chrono::DateTime::from_timestamp(message.created_at, 0)
                .unwrap_or_else(Utc::now),
            reply_to_message_id: message.reply_to_message_id.clone(),
            mentions: message.mentions.clone(),
            model: message.model.clone(),
            metadata_json: message.metadata_json.clone(),
            turn_id: message.turn_id.clone(),
        };

        let mut store = MessageStore::load(&self.config_dir, session_id)?;
        store.append(stored);
        store.save(&self.config_dir, session_id)?;
        Ok(())
    }

    /// Returns the agent actor_ids that should receive this message.
    ///
    /// If there's only one agent in the session, all messages are relevant.
    /// Otherwise, only agents that are explicitly mentioned.
    pub fn agents_to_activate(&self, session_id: &str, message: &teamclaw::Message) -> Vec<String> {
        let session = match self.sessions.find_by_id(session_id) {
            Some(s) => s,
            None => return vec![],
        };

        let agents: Vec<String> = session
            .participants
            .iter()
            .filter(|p| p.actor_type == "personal_agent" || p.actor_type == "role_agent")
            .map(|p| p.actor_id.clone())
            .collect();

        if agents.len() == 1 {
            // Only one agent — all messages activate it
            return agents;
        }

        // Multiple agents — only activate those mentioned
        agents
            .into_iter()
            .filter(|actor_id| message.mentions.contains(actor_id))
            .collect()
    }

    /// Returns the agent actor_ids that should be activated for a idea event.
    ///
    /// - Claimed → activate the claiming agent
    /// - Updated → activate all agents that claimed the idea
    /// - Submitted → activate other claimants (not the submitter)
    pub fn agents_to_activate_for_idea(
        &self,
        session_id: &str,
        event: &teamclaw::IdeaEvent,
    ) -> Vec<String> {
        match &event.event {
            Some(teamclaw::idea_event::Event::Claimed(claim)) => {
                vec![claim.actor_id.clone()]
            }
            Some(teamclaw::idea_event::Event::Updated(idea)) => {
                // Activate all agents that claimed this idea
                match IdeaStore::load(&self.config_dir, canonical_idea_store_key(session_id)) {
                    Ok(store) => store
                        .claims_for_idea(&idea.idea_id)
                        .into_iter()
                        .map(|c| c.actor_id.clone())
                        .collect(),
                    Err(_) => vec![],
                }
            }
            Some(teamclaw::idea_event::Event::Submitted(submission)) => {
                // Activate other claimants (not the submitter)
                match IdeaStore::load(&self.config_dir, canonical_idea_store_key(session_id)) {
                    Ok(store) => store
                        .claims_for_idea(&submission.idea_id)
                        .into_iter()
                        .filter(|c| c.actor_id != submission.actor_id)
                        .map(|c| c.actor_id.clone())
                        .collect(),
                    Err(_) => vec![],
                }
            }
            Some(teamclaw::idea_event::Event::Created(_)) | None => vec![],
        }
    }

    /// Get session_ids where this agent participates.
    pub fn sessions_for_agent(&self, agent_actor_id: &str) -> Vec<String> {
        self.sessions
            .sessions
            .iter()
            .filter(|s| s.participants.iter().any(|p| p.actor_id == agent_actor_id))
            .map(|s| s.session_id.clone())
            .collect()
    }

    /// Fan-out wrapper around `LivePublisher::publish_acp_event` for a single
    /// session. Mirrors the `publish_agent_message` indirection so server.rs
    /// can stay decoupled from the LivePublisher type.
    pub async fn publish_agent_acp_event(
        &self,
        session_id: &str,
        agent_actor_id: &str,
        envelope: &crate::proto::amux::Envelope,
    ) {
        let _ = self
            .live_publisher
            .publish_acp_event(session_id, agent_actor_id, envelope)
            .await;
    }

    /// Publish an agent's output as a session message.
    ///
    /// `model` is the model id the agent was running on when it produced this
    /// reply (looked up from `RuntimeManager.current_model` by the caller).
    /// Pass an empty string for legacy / unknown.
    pub async fn publish_agent_message(
        &self,
        session_id: &str,
        agent_actor_id: &str,
        content: &str,
        model: &str,
    ) {
        let msg = teamclaw::Message {
            message_id: Uuid::new_v4().to_string()[..8].to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: agent_actor_id.to_string(),
            kind: teamclaw::MessageKind::Text as i32,
            content: content.to_string(),
            created_at: Utc::now().timestamp(),
            model: model.to_string(),
            ..Default::default()
        };
        let envelope = teamclaw::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec![],
        };
        let _ = self
            .live_publisher
            .publish_message(session_id, agent_actor_id, &envelope)
            .await;
    }

    /// Emit one logical agent message: append to local TOML, publish to
    /// session/live as `message.created`, and (if `persist_supabase`) write
    /// to Supabase `messages`. The Supabase write is fire-and-forget — local
    /// TOML and session/live are the source of truth for iOS rendering.
    #[allow(clippy::too_many_arguments)]
    pub async fn emit_agent_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        kind: crate::proto::teamclaw::MessageKind,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        persist_supabase: bool,
        supabase: Option<&crate::supabase::SupabaseClient>,
    ) {
        let message_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
        let now = chrono::Utc::now();

        let proto_msg = crate::proto::teamclaw::Message {
            message_id: message_id.clone(),
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.to_string(),
            kind: kind as i32,
            content: content.to_string(),
            created_at: now.timestamp(),
            model: model.to_string(),
            metadata_json: metadata_json.to_string(),
            turn_id: turn_id.to_string(),
            ..Default::default()
        };

        // 1. Local TOML
        if let Err(e) = self.persist_message(session_id, &proto_msg).await {
            warn!(?e, session_id, "persist_message failed");
        }

        // 2. session/{sid}/live as `message.created`.
        //    Multi-daemon sessions (peer daemon B's runtimes need to see
        //    daemon A's agent reply as silent context) require AgentReply
        //    to land on the live channel. iOS no longer renders these as
        //    chat bubbles — the kind filter in handleIncomingChatMessage
        //    drops agent_reply and lets handleAcpEvent's isComplete=true
        //    output own that bubble.
        let envelope = crate::proto::teamclaw::SessionMessageEnvelope {
            message: Some(proto_msg.clone()),
            mention_actor_ids: Vec::new(), // agent reply addresses no one
        };
        if let Err(e) = self
            .live_publisher
            .publish_message(session_id, sender_actor_id, &envelope)
            .await
        {
            warn!(?e, session_id, "publish_message failed");
        }

        // 3. Supabase (final replies only — see TurnAggregator::supabase_persistent)
        if persist_supabase {
            if let Some(sb) = supabase {
                let team_id = self.team_id.clone();
                // message_kind_to_string is the pub(crate) fn defined later in this file.
                let kind_str = message_kind_to_string(kind as i32);
                let session = session_id.to_string();
                let sender = sender_actor_id.to_string();
                let content_owned = content.to_string();
                let meta_owned = metadata_json.to_string();
                let model_owned = model.to_string();
                let turn_owned = turn_id.to_string();
                let sb_clone = sb.clone();
                tokio::spawn(async move {
                    if let Err(e) = sb_clone
                        .insert_message(
                            &team_id,
                            &session,
                            &sender,
                            &kind_str,
                            &content_owned,
                            &meta_owned,
                            &model_owned,
                            &turn_owned,
                        )
                        .await
                    {
                        warn!(?e, "Supabase insert_message failed");
                    }
                });
            }
        }
    }

    pub async fn publish_live_message(
        &self,
        session_id: &str,
        message: &teamclaw::Message,
    ) -> crate::error::Result<()> {
        let envelope = teamclaw::SessionMessageEnvelope {
            message: Some(message.clone()),
            mention_actor_ids: vec![],
        };
        self.live_publisher
            .publish_message(session_id, &message.sender_actor_id, &envelope)
            .await
    }

    pub async fn ensure_session_subscription(
        &mut self,
        _session_id: &str,
    ) -> crate::error::Result<()> {
        self.refresh_membership_subscriptions().await
    }

    pub async fn refresh_membership_subscriptions(&mut self) -> crate::error::Result<()> {
        self.apply_membership_sessions(self.membership_session_ids())
            .await
    }

    pub async fn apply_membership_sessions(
        &mut self,
        session_ids: Vec<String>,
    ) -> crate::error::Result<()> {
        let desired: BTreeSet<String> = session_ids
            .into_iter()
            .filter(|session_id| !session_id.is_empty())
            .collect();

        let to_subscribe: Vec<String> = desired
            .difference(&self.subscribed_live_sessions)
            .cloned()
            .collect();
        let to_unsubscribe: Vec<String> = self
            .subscribed_live_sessions
            .difference(&desired)
            .cloned()
            .collect();

        for session_id in &to_subscribe {
            self.subscribe_session_live(session_id).await?;
            self.request_recent_session_events(session_id).await?;
        }

        for session_id in &to_unsubscribe {
            self.unsubscribe_session_live(session_id).await?;
        }

        self.subscribed_live_sessions = desired;
        Ok(())
    }

    pub fn subscribed_live_sessions(&self) -> Vec<String> {
        self.subscribed_live_sessions.iter().cloned().collect()
    }

    pub fn should_process_message(&mut self, session_id: &str, message_id: &str) -> bool {
        self.record_recent_event(format!("message:{session_id}:{message_id}"))
    }

    pub fn should_process_idea_event(
        &mut self,
        session_id: &str,
        event: &teamclaw::IdeaEvent,
    ) -> bool {
        let key = match &event.event {
            Some(teamclaw::idea_event::Event::Created(idea)) => {
                format!("idea-created:{session_id}:{}", idea.idea_id)
            }
            Some(teamclaw::idea_event::Event::Updated(idea)) => {
                format!("idea-updated:{session_id}:{}", idea.idea_id)
            }
            Some(teamclaw::idea_event::Event::Claimed(claim)) => {
                format!("claim:{session_id}:{}", claim.claim_id)
            }
            Some(teamclaw::idea_event::Event::Submitted(submission)) => {
                format!("submission:{session_id}:{}", submission.submission_id)
            }
            None => return true,
        };
        self.record_recent_event(key)
    }

    // --- Private helpers ---

    async fn subscribe_session_live(&self, session_id: &str) -> crate::error::Result<()> {
        #[cfg(test)]
        if self.skip_live_subscription_io {
            return Ok(());
        }
        let topic = self.live_session_topic(session_id);
        self.client.subscribe(&topic, QoS::AtLeastOnce).await?;
        info!(session_id, topic = %topic, "subscribed to session live");
        Ok(())
    }

    async fn unsubscribe_session_live(&self, session_id: &str) -> crate::error::Result<()> {
        #[cfg(test)]
        if self.skip_live_subscription_io {
            return Ok(());
        }
        let topic = self.live_session_topic(session_id);
        self.client.unsubscribe(&topic).await?;
        // We've seen "second user message never lands on daemon" reports
        // that look like the subscription went away between turns —
        // surface every unsubscribe so the next repro shows whether it
        // happened, and which membership-refresh path triggered it.
        warn!(session_id, topic = %topic, "unsubscribed from session live");
        Ok(())
    }

    fn base_subscription_topics(&self) -> Vec<String> {
        vec![
            self.topics.device_rpc_req(),
            self.topics.device_notify(),
            self.topics.device_rpc_res(),
        ]
    }

    fn live_session_topic(&self, session_id: &str) -> String {
        self.topics.session_live(session_id)
    }

    fn membership_session_ids(&self) -> Vec<String> {
        let local_actor_id = self.actor_id.as_deref();
        self.sessions
            .sessions
            .iter()
            .filter(|session| {
                local_actor_id.is_some_and(|actor_id| {
                    session
                        .participants
                        .iter()
                        .any(|participant| participant.actor_id == actor_id)
                })
            })
            .map(|session| session.session_id.clone())
            .collect()
    }

    async fn request_recent_session_events(&self, _session_id: &str) -> crate::error::Result<()> {
        Ok(())
    }

    fn record_recent_event(&mut self, key: String) -> bool {
        if key.is_empty() {
            return true;
        }
        if self.recent_event_keys.contains(&key) {
            return false;
        }

        self.recent_event_keys.insert(key.clone());
        self.recent_event_order.push_back(key);

        while self.recent_event_order.len() > RECENT_EVENT_CACHE_LIMIT {
            if let Some(oldest) = self.recent_event_order.pop_front() {
                self.recent_event_keys.remove(&oldest);
            }
        }

        true
    }

    fn membership_refresh_targets(
        &self,
        session_id: &str,
        requester_device_id: Option<&str>,
    ) -> Vec<String> {
        let mut targets = Vec::new();

        if let Some(requester_device_id) = requester_device_id {
            if !requester_device_id.is_empty() && requester_device_id != self.device_id {
                targets.push(requester_device_id.to_string());
            }
        }

        // The current request shapes only identify actors being invited/removed,
        // not the target device for those actors, so direct invitee targeting
        // is not possible here without additional membership/device mapping.
        targets
    }
}

// --- Helpers ---

fn actor_type_to_string(actor_type: i32) -> String {
    match actor_type {
        x if x == teamclaw::ActorType::Human as i32 => "human",
        x if x == teamclaw::ActorType::PersonalAgent as i32 => "personal_agent",
        x if x == teamclaw::ActorType::RoleAgent as i32 => "role_agent",
        _ => "unknown",
    }
    .to_string()
}

fn participant_is_agent(actor_type: i32) -> bool {
    actor_type == teamclaw::ActorType::PersonalAgent as i32
        || actor_type == teamclaw::ActorType::RoleAgent as i32
}

fn stored_participant_to_proto(participant: &StoredParticipant) -> teamclaw::Participant {
    teamclaw::Participant {
        actor_id: participant.actor_id.clone(),
        actor_type: match participant.actor_type.as_str() {
            "human" => teamclaw::ActorType::Human as i32,
            "personal_agent" => teamclaw::ActorType::PersonalAgent as i32,
            "role_agent" => teamclaw::ActorType::RoleAgent as i32,
            _ => teamclaw::ActorType::Unknown as i32,
        },
        display_name: participant.display_name.clone(),
        joined_at: participant.joined_at.timestamp(),
    }
}

fn canonical_idea_store_key(session_id: &str) -> &str {
    if session_id.is_empty() {
        "global"
    } else {
        session_id
    }
}

pub(crate) fn message_kind_to_string(kind: i32) -> String {
    match teamclaw::MessageKind::try_from(kind).unwrap_or(teamclaw::MessageKind::Unknown) {
        teamclaw::MessageKind::Text => "text",
        teamclaw::MessageKind::System => "system",
        teamclaw::MessageKind::WorkEvent => "work_event",
        teamclaw::MessageKind::AgentThinking => "agent_thinking",
        teamclaw::MessageKind::AgentToolCall => "agent_tool_call",
        teamclaw::MessageKind::AgentToolResult => "agent_tool_result",
        teamclaw::MessageKind::AgentReply => "agent_reply",
        teamclaw::MessageKind::Unknown => "unknown",
    }
    .to_string()
}

fn idea_status_to_string(status: i32) -> String {
    match status {
        x if x == teamclaw::IdeaStatus::Open as i32 => "open",
        x if x == teamclaw::IdeaStatus::InProgress as i32 => "in_progress",
        x if x == teamclaw::IdeaStatus::Done as i32 => "done",
        _ => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::teamclaw::{IdeaStore, StoredClaim, StoredParticipant, StoredSession};
    use chrono::Utc;
    use std::path::Path;
    use tempfile::TempDir;

    fn dummy_session_manager(config_dir: &Path) -> SessionManager {
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let mut manager =
            SessionManager::new(client, "team1", "dev-a", None, config_dir.to_path_buf()).unwrap();
        manager.skip_live_subscription_io = true;
        manager
    }

    fn make_session(id: &str) -> StoredSession {
        StoredSession {
            session_id: id.to_string(),
            team_id: "team1".to_string(),
            title: format!("Session {}", id),
            created_by: "user1".to_string(),
            created_at: Utc::now(),
            summary: String::new(),
            participants: vec![],
            primary_agent_id: String::new(),
            idea_id: String::new(),
        }
    }

    fn make_agent_participant(actor_id: &str) -> StoredParticipant {
        StoredParticipant {
            actor_id: actor_id.to_string(),
            actor_type: "personal_agent".to_string(),
            display_name: actor_id.to_string(),
            joined_at: Utc::now(),
        }
    }

    fn make_human_participant(actor_id: &str) -> StoredParticipant {
        StoredParticipant {
            actor_id: actor_id.to_string(),
            actor_type: "human".to_string(),
            display_name: actor_id.to_string(),
            joined_at: Utc::now(),
        }
    }

    fn make_message(session_id: &str, mentions: Vec<String>) -> teamclaw::Message {
        teamclaw::Message {
            message_id: "msg1".to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "human1".to_string(),
            kind: teamclaw::MessageKind::Text as i32,
            content: "hello".to_string(),
            created_at: Utc::now().timestamp(),
            mentions,
            ..Default::default()
        }
    }

    // --- agents_to_activate tests ---

    #[test]
    fn test_agents_to_activate_no_session() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());
        let msg = make_message("nonexistent", vec![]);
        let result = sm.agents_to_activate("nonexistent", &msg);
        assert!(result.is_empty());
    }

    #[test]
    fn test_agents_to_activate_session_no_agents() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_human_participant("human1"));
        sm.sessions.upsert(session);

        let msg = make_message("s1", vec![]);
        let result = sm.agents_to_activate("s1", &msg);
        assert!(result.is_empty());
    }

    #[test]
    fn test_agents_to_activate_sole_agent_gets_all_messages() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_human_participant("human1"));
        session.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(session);

        // No mentions — sole agent still receives it
        let msg = make_message("s1", vec![]);
        let result = sm.agents_to_activate("s1", &msg);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_agents_to_activate_two_agents_mentioned_one() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_agent_participant("agent1"));
        session.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(session);

        let msg = make_message("s1", vec!["agent1".to_string()]);
        let result = sm.agents_to_activate("s1", &msg);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_agents_to_activate_two_agents_no_mention_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_agent_participant("agent1"));
        session.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(session);

        let msg = make_message("s1", vec![]);
        let result = sm.agents_to_activate("s1", &msg);
        assert!(result.is_empty());
    }

    #[test]
    fn test_agents_to_activate_sender_is_agent_still_returned() {
        // Filtering out the sender happens in server.rs, not here.
        // The method should still return the agent even if they sent the message.
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut session = make_session("s1");
        session.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(session);

        let mut msg = make_message("s1", vec![]);
        msg.sender_actor_id = "agent1".to_string();

        let result = sm.agents_to_activate("s1", &msg);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_membership_refresh_targets_only_include_requester() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let targets = sm.membership_refresh_targets("s1", Some("dev-requester"));
        assert_eq!(targets, vec!["dev-requester".to_string()]);
    }

    #[test]
    fn test_membership_refresh_targets_skip_local_requester() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let targets = sm.membership_refresh_targets("s1", Some("dev-a"));
        assert!(targets.is_empty());
    }

    fn make_test_session_manager_with_actor(actor_id: &str) -> (TempDir, SessionManager) {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some(actor_id.to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;
        (tmp, sm)
    }

    fn test_message(sender_actor_id: &str, session_id: &str, content: &str) -> teamclaw::Message {
        teamclaw::Message {
            message_id: "msg-test".to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: sender_actor_id.to_string(),
            kind: teamclaw::MessageKind::Text as i32,
            content: content.to_string(),
            created_at: Utc::now().timestamp(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn test_insert_session_from_supabase_subscribes_when_daemon_is_participant() {
        let (_tmp, mut sm) = make_test_session_manager_with_actor("daemon-actor-1");

        sm.insert_session_from_supabase_for_test(
            "sess-1",
            "team-1",
            Some("daemon-actor-1"),
            &[("user-1", "member"), ("daemon-actor-1", "member")],
        )
        .await
        .unwrap();

        let subs = sm.subscribed_live_sessions();
        assert!(
            subs.contains(&"sess-1".to_string()),
            "expected sess-1 to be subscribed; got {subs:?}"
        );

        let msg = test_message("user-1", "sess-1", "hello");
        let activated = sm.agents_to_activate("sess-1", &msg);
        assert_eq!(activated, vec!["daemon-actor-1".to_string()]);
    }

    #[tokio::test]
    async fn test_apply_membership_sessions_adds_and_removes_live_subscriptions() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        sm.apply_membership_sessions(vec!["sess-1".to_string(), "sess-2".to_string()])
            .await
            .unwrap();
        assert_eq!(
            sm.subscribed_live_sessions(),
            vec!["sess-1".to_string(), "sess-2".to_string()]
        );

        sm.apply_membership_sessions(vec!["sess-2".to_string()])
            .await
            .unwrap();
        assert_eq!(sm.subscribed_live_sessions(), vec!["sess-2".to_string()]);
    }

    #[tokio::test]
    async fn test_refresh_membership_subscriptions_uses_local_actor_truth() {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some("member-a".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;

        let mut joined = make_session("joined");
        joined.participants.push(make_human_participant("member-a"));

        let mut unrelated = make_session("unrelated");
        unrelated
            .participants
            .push(make_human_participant("someone-else"));

        sm.sessions.upsert(joined);
        sm.sessions.upsert(unrelated);

        sm.refresh_membership_subscriptions().await.unwrap();

        assert_eq!(sm.subscribed_live_sessions(), vec!["joined".to_string()]);
    }

    #[tokio::test]
    async fn test_subscribe_all_rebuilds_live_set_from_membership_truth() {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some("member-a".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;

        let mut joined = make_session("joined");
        joined.participants.push(make_human_participant("member-a"));

        sm.sessions.upsert(joined);

        sm.subscribe_all().await.unwrap();

        assert_eq!(sm.subscribed_live_sessions(), vec!["joined".to_string()]);
    }

    #[tokio::test]
    async fn test_subscribe_all_reconciles_live_set_after_membership_changes() {
        let tmp = TempDir::new().unwrap();
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let mut sm = SessionManager::new(
            client,
            "team1",
            "dev-a",
            Some("member-a".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();
        sm.skip_live_subscription_io = true;

        let mut joined = make_session("joined");
        joined.participants.push(make_human_participant("member-a"));

        sm.sessions.upsert(joined);
        sm.subscribe_all().await.unwrap();
        assert_eq!(sm.subscribed_live_sessions(), vec!["joined".to_string()]);

        let mut unrelated = make_session("replacement");
        sm.sessions.sessions.clear();
        sm.sessions.upsert(unrelated);

        sm.subscribe_all().await.unwrap();

        assert!(sm.subscribed_live_sessions().is_empty());
    }

    #[test]
    fn test_base_subscription_topics_exclude_retained_session_state_topics() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());
        sm.actor_id = Some("member-a".to_string());

        let topics = sm.base_subscription_topics();

        assert!(topics.contains(&"amux/team1/device/dev-a/rpc/req".to_string()));
        assert!(topics.contains(&"amux/team1/device/dev-a/rpc/res".to_string()));
        assert!(topics.contains(&"amux/team1/device/dev-a/notify".to_string()));
        assert!(!topics.contains(&"amux/team1/sessions".to_string()));
        assert!(!topics
            .iter()
            .any(|topic| topic.contains("/actor/member-a/session/")));
    }

    #[test]
    fn test_session_live_topic_is_distinct_from_legacy_rollout_topics() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        let live = sm.live_session_topic("s1");

        assert_eq!(live, "amux/team1/session/s1/live");
    }

    #[test]
    fn test_recent_event_dedupe_uses_stable_ids() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        assert!(sm.should_process_message("s1", "m1"));
        assert!(!sm.should_process_message("s1", "m1"));

        let created = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Created(teamclaw::Idea {
                idea_id: "t1".to_string(),
                session_id: "s1".to_string(),
                ..Default::default()
            })),
        };
        let updated = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Updated(teamclaw::Idea {
                idea_id: "t1".to_string(),
                session_id: "s1".to_string(),
                ..Default::default()
            })),
        };
        assert!(sm.should_process_idea_event("s1", &created));
        assert!(!sm.should_process_idea_event("s1", &created));
        assert!(sm.should_process_idea_event("s1", &updated));
        assert!(!sm.should_process_idea_event("s1", &updated));
    }

    #[test]
    fn test_canonical_idea_store_key_maps_empty_to_global() {
        assert_eq!(canonical_idea_store_key(""), "global");
        assert_eq!(canonical_idea_store_key("s1"), "s1");
    }

    // --- agents_to_activate_for_idea tests ---

    #[test]
    fn test_idea_claimed_returns_claimant() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        let claim = teamclaw::Claim {
            claim_id: "c1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(),
            claimed_at: Utc::now().timestamp(),
        };
        let event = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Claimed(claim)),
        };

        let result = sm.agents_to_activate_for_idea("s1", &event);
        assert_eq!(result, vec!["agent1".to_string()]);
    }

    #[test]
    fn test_idea_updated_returns_all_claimants() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        // Set up IdeaStore on disk with two claims for "w1"
        let mut store = IdeaStore::default();
        store.claims.push(StoredClaim {
            claim_id: "c1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(),
            claimed_at: Utc::now(),
        });
        store.claims.push(StoredClaim {
            claim_id: "c2".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent2".to_string(),
            claimed_at: Utc::now(),
        });
        store.save(tmp.path(), "s1").unwrap();

        let idea = teamclaw::Idea {
            idea_id: "w1".to_string(),
            session_id: "s1".to_string(),
            ..Default::default()
        };
        let event = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Updated(idea)),
        };

        let mut result = sm.agents_to_activate_for_idea("s1", &event);
        result.sort();
        assert_eq!(result, vec!["agent1".to_string(), "agent2".to_string()]);
    }

    #[test]
    fn test_idea_submitted_returns_other_claimants() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        // agent1 and agent2 claimed w1; agent1 submits — only agent2 should be notified
        let mut store = IdeaStore::default();
        store.claims.push(StoredClaim {
            claim_id: "c1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(),
            claimed_at: Utc::now(),
        });
        store.claims.push(StoredClaim {
            claim_id: "c2".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent2".to_string(),
            claimed_at: Utc::now(),
        });
        store.save(tmp.path(), "s1").unwrap();

        let submission = teamclaw::Submission {
            submission_id: "sub1".to_string(),
            idea_id: "w1".to_string(),
            actor_id: "agent1".to_string(), // submitter
            content: "done".to_string(),
            submitted_at: Utc::now().timestamp(),
        };
        let event = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Submitted(submission)),
        };

        let result = sm.agents_to_activate_for_idea("s1", &event);
        assert_eq!(result, vec!["agent2".to_string()]);
    }

    #[test]
    fn test_idea_created_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let sm = dummy_session_manager(tmp.path());

        let idea = teamclaw::Idea {
            idea_id: "w1".to_string(),
            session_id: "s1".to_string(),
            ..Default::default()
        };
        let event = teamclaw::IdeaEvent {
            event: Some(teamclaw::idea_event::Event::Created(idea)),
        };

        let result = sm.agents_to_activate_for_idea("s1", &event);
        assert!(result.is_empty());
    }

    // --- sessions_for_agent tests ---

    #[test]
    fn test_sessions_for_agent_in_two_sessions() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut s1 = make_session("s1");
        s1.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(s1);

        let mut s2 = make_session("s2");
        s2.participants.push(make_agent_participant("agent1"));
        sm.sessions.upsert(s2);

        // s3 does not have agent1
        let mut s3 = make_session("s3");
        s3.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(s3);

        let mut result = sm.sessions_for_agent("agent1");
        result.sort();
        assert_eq!(result, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn test_sessions_for_agent_not_in_any_session() {
        let tmp = TempDir::new().unwrap();
        let mut sm = dummy_session_manager(tmp.path());

        let mut s1 = make_session("s1");
        s1.participants.push(make_agent_participant("agent2"));
        sm.sessions.upsert(s1);

        let result = sm.sessions_for_agent("agent1");
        assert!(result.is_empty());
    }
}
