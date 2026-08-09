import Foundation
import Observation
import SwiftData

// MARK: - SessionGroup

public struct SessionGroup: Identifiable {
    public let id: String
    public let title: String
    public var items: [Session]
}

extension Session {
    /// Sort/grouping key — most recent activity falls back to creation time.
    public var listDate: Date { lastMessageAt ?? createdAt }
}

@Observable @MainActor
public final class SessionListViewModel {
    /// Live attachments projected from every subscribed actor's `ActorPresence`
    /// retain, keyed `{actor}::{session}`. A session absent here is cold.
    public var attachments: [AgentAttachment] = []
    public var workspaces: [Workspace] = []
    public var sessions: [Session] = []
    public var isLoading = true
    public var searchText = ""
    private var task: Task<Void, Never>?
    private var inboxTask: Task<Void, Never>?
    // Retained so markAsRead() can mutate the same context the ingest uses.
    private var ctx: ModelContext?

    public init() {}

    public func start(mqtt: MQTTService,
                      hub: MQTTMessageHub,
                      teamID: String = "",
                      connectedAgentsStore: ConnectedAgentsStore?,
                      modelContext: ModelContext,
                      teamclawService: TeamclawService? = nil) {
        // Create a dedicated context from the same container for async work
        let container = modelContext.container
        let ctx = ModelContext(container)
        self.ctx = ctx

        // Load cached data immediately
        attachments = (try? ctx.fetch(FetchDescriptor<AgentAttachment>(sortBy: [SortDescriptor(\.lastEventTime, order: .reverse)]))) ?? []
        workspaces = (try? ctx.fetch(FetchDescriptor<Workspace>(sortBy: [SortDescriptor(\.displayName)]))) ?? []
        sessions = (try? ctx.fetch(FetchDescriptor<Session>(sortBy: [SortDescriptor(\.lastMessageAt, order: .reverse)]))) ?? []

        task?.cancel()

        // Each daemon publishes one retained `amux/{team}/{actor}/state`
        // carrying its whole presence: active backend, model catalogs, and the
        // sessions it currently holds an attachment for. One message per actor,
        // every field bounded — the per-spawn fan-out it replaced could not be
        // bounded because `runtime_id` was minted fresh on every start.
        task = Task { [weak self] in
            guard let self else { return }
            // Outer loop: each iteration represents a fresh MQTT connection
            // lifecycle. When the inner stream ends (disconnect clears
            // continuations), loop back, wait for reconnect, and resubscribe
            // so the broker re-delivers retained runtime/workspace lists.
            while !Task.isCancelled {
                var waited = 0
                while mqtt.connectionState != .connected {
                    try? await Task.sleep(for: .milliseconds(200))
                    if Task.isCancelled { return }
                    waited += 200
                    if waited >= 15_000 {
                        NSLog("[SessionListVM] timed out waiting for MQTT (state: %@)", String(describing: mqtt.connectionState))
                        isLoading = false
                        break
                    }
                }
                if Task.isCancelled { return }
                if mqtt.connectionState != .connected {
                    try? await Task.sleep(for: .seconds(1))
                    continue
                }

                // Hub-filtered stream: only actor-state topics for this team.
                // The per-actor subscriptions below decide which daemons the
                // broker actually delivers from; the predicate is the belt to
                // that suspenders.
                let stream = await hub.messages(matching: { [teamID] msg in
                    SessionListViewModel.parseActorStateTopic(msg.topic, teamID: teamID) != nil
                })

                // Per-agent subscription set, kept in sync with
                // connectedAgentsStore.agents via Observation tracking below.
                await self.resyncActorStateSubscriptions(
                    mqtt: mqtt,
                    teamID: teamID,
                    store: connectedAgentsStore
                )
                self.isLoading = false

                let observer = Task { [weak self] in
                    guard let self else { return }
                    while !Task.isCancelled {
                        await self.waitForAgentsMutation(store: connectedAgentsStore)
                        if Task.isCancelled { return }
                        await self.resyncActorStateSubscriptions(
                            mqtt: mqtt,
                            teamID: teamID,
                            store: connectedAgentsStore
                        )
                    }
                }

                if let teamclawService {
                    Task { [weak self] in
                        guard let self else { return }
                        let workspaces = await teamclawService.fetchWorkspaces()
                        self.syncWorkspaces(workspaces, modelContext: ctx)
                    }
                }

                for await msg in stream {
                    if let actorID = Self.parseActorStateTopic(msg.topic, teamID: teamID) {
                        // An empty payload is the LWT / offline marker; a
                        // presence-only publish carries no attachments either.
                        // Both mean the same thing here: nothing live to show.
                        guard !msg.payload.isEmpty,
                              let presence = try? ProtoMQTTCoder.decode(
                                  Amux_ActorPresence.self, from: msg.payload
                              ) else { continue }
                        self.syncActorPresence(presence, actorID: actorID, modelContext: ctx)
                        self.refreshSessions(modelContext: ctx)
                    }
                }
                observer.cancel()
                if Task.isCancelled { return }
                NSLog("[SessionListVM] stream ended, waiting to resubscribe…")
            }
        }
    }

    public func stop() {
        task?.cancel(); task = nil
        inboxTask?.cancel(); inboxTask = nil
    }

    // MARK: - Inbox red-dot subscription
    //
    // Server fans out a `{session_id, ts}` ping to `inbox/<actor_id>` after
    // every message INSERT in a session the actor belongs to (see FC
    // push-dispatch fan-out, PR #98). The client subscribes to this single
    // per-user topic and updates the local Session.hasUnread cache.
    // has_unread itself is computed server-side from `session_read_markers`
    // + `sessions.last_message_at` — see SupabaseSessionsRepository.

    /// Subscribes to `inbox/<actorID>` on the MQTT broker and updates
    /// Session.hasUnread on each ping. Safe to call after start(); cancels
    /// any previous inbox subscription.
    public func startInboxSubscription(
        mqtt: MQTTService,
        hub: MQTTMessageHub,
        actorID: String,
        teamID: String,
        sessionsRepo: SessionsRepository?,
        modelContext: ModelContext
    ) {
        guard !actorID.isEmpty else {
            NSLog("[SessionListVM] startInboxSubscription: empty actorID, skipping")
            return
        }
        let topic = "inbox/\(actorID)"

        inboxTask?.cancel()
        let container = modelContext.container
        inboxTask = Task { [weak self] in
            guard let self else { return }
            let ctx = ModelContext(container)

            // Wait for MQTT connect (same pattern as the runtime-state loop).
            var waited = 0
            while mqtt.connectionState != .connected {
                try? await Task.sleep(for: .milliseconds(200))
                if Task.isCancelled { return }
                waited += 200
                if waited >= 15_000 {
                    NSLog("[SessionListVM] inbox: timed out waiting for MQTT")
                    return
                }
            }

            do {
                try await mqtt.subscribe(topic)
                NSLog("[SessionListVM] inbox: subscribed to %@", topic)
            } catch {
                NSLog("[SessionListVM] inbox: subscribe failed: %@", String(describing: error))
                return
            }

            let stream = await hub.messages(matching: { msg in msg.topic == topic })
            for await msg in stream {
                if Task.isCancelled { return }
                switch parseInboxEnvelope(topic: msg.topic, payload: msg.payload, expectedUserID: actorID) {
                case .success(let ping):
                    await self.applyInboxPing(ping, teamID: teamID, sessionsRepo: sessionsRepo, modelContext: ctx)
                case .failure(let err):
                    NSLog("[SessionListVM] inbox: parse failed (%@)", String(describing: err))
                }
            }
        }
    }

    @MainActor
    private func applyInboxPing(
        _ ping: InboxPing,
        teamID: String,
        sessionsRepo: SessionsRepository?,
        modelContext: ModelContext
    ) async {
        let sid = ping.sessionID
        let descriptor = FetchDescriptor<Session>(predicate: #Predicate { $0.sessionId == sid })

        if ping.type == "read" {
            // Another device marked this session read — clear the badge locally.
            if let session = try? modelContext.fetch(descriptor).first, session.hasUnread {
                session.hasUnread = false
                try? modelContext.save()
                reloadSessions(modelContext: modelContext)
            }
            return
        }

        // type == "message" or nil (legacy) — a new message arrived.
        if let session = try? modelContext.fetch(descriptor).first {
            // Optimistic local update — server already knows the truth, the
            // next applyUnreadFlags() will confirm it. Skipping the no-op
            // avoids an unnecessary SwiftData save and UI churn.
            if !session.hasUnread {
                session.hasUnread = true
                try? modelContext.save()
                reloadSessions(modelContext: modelContext)
            }
        } else if let repo = sessionsRepo, !teamID.isEmpty {
            // Unknown session id — likely a brand-new session for this user.
            // Pull the authoritative set so the row appears with the right flag.
            if let flags = try? await repo.fetchUnreadFlags(teamID: teamID, limit: 100) {
                applyUnreadFlags(flags, modelContext: modelContext)
            }
        }
    }

    /// Overlays the server-side `(session_id, has_unread)` map onto local
    /// Session rows. Sessions absent from the map keep their current local
    /// state — the map represents the user's current session set, but the
    /// caller may have a broader local cache (e.g., archived sessions).
    @MainActor
    public func applyUnreadFlags(_ flags: [String: Bool], modelContext: ModelContext) {
        let existing = (try? modelContext.fetch(FetchDescriptor<Session>())) ?? []
        var changed = false
        for session in existing {
            guard let serverUnread = flags[session.sessionId] else { continue }
            if session.hasUnread != serverUnread {
                session.hasUnread = serverUnread
                changed = true
            }
        }
        if changed {
            try? modelContext.save()
            reloadSessions(modelContext: modelContext)
        }
    }

    /// Clears the unread flag locally for immediate UI feedback and tells
    /// the server via `mark_current_actor_session_viewed`. Fire-and-forget:
    /// the server call's success is not awaited — the next inbox ping or
    /// applyUnreadFlags() will reconcile if the write was lost.
    @MainActor
    public func markSessionViewed(
        sessionId: String,
        sessionsRepo: SessionsRepository?,
        modelContext: ModelContext,
        lastReadMessageId: String? = nil
    ) {
        let sid = sessionId
        let descriptor = FetchDescriptor<Session>(predicate: #Predicate { $0.sessionId == sid })
        if let session = try? modelContext.fetch(descriptor).first, session.hasUnread {
            session.hasUnread = false
            try? modelContext.save()
            reloadSessions(modelContext: modelContext)
        }
        if let repo = sessionsRepo {
            Task {
                try? await repo.markSessionViewed(sessionId: sid, lastReadMessageId: lastReadMessageId)
            }
        }
    }

    /// Flags the session unread again — optimistic local flip for instant
    /// row feedback, then the server rewind so other devices agree. Unlike
    /// `markSessionViewed` the remote write is awaited: a failed rewind
    /// must roll the local flag back, otherwise the red dot would silently
    /// vanish on the next `applyUnreadFlags` reconcile anyway.
    @MainActor
    public func markSessionUnread(
        sessionId: String,
        sessionsRepo: SessionsRepository?,
        modelContext: ModelContext
    ) async {
        let sid = sessionId
        let descriptor = FetchDescriptor<Session>(predicate: #Predicate { $0.sessionId == sid })
        guard let session = try? modelContext.fetch(descriptor).first, !session.hasUnread else { return }
        session.hasUnread = true
        try? modelContext.save()
        reloadSessions(modelContext: modelContext)

        guard let repo = sessionsRepo else { return }
        do {
            try await repo.markSessionUnread(sessionId: sid)
        } catch {
            session.hasUnread = false
            try? modelContext.save()
            reloadSessions(modelContext: modelContext)
        }
    }

    /// Clears the unread badge for the given runtime in the same ModelContext
    /// the ingest uses, so the session list row updates immediately.
    /// Clears the local unread dot for a session. The authoritative flag is
    /// server-computed and arrives on the next list fetch; this just stops the
    /// dot lingering between opening the session and that refresh.
    public func markAsRead(sessionId: String) {
        guard !sessionId.isEmpty,
              let session = sessions.first(where: { $0.sessionId == sessionId }),
              session.hasUnread else { return }
        session.hasUnread = false
        try? ctx?.save()
    }

    /// Diffs the desired agent actor-id set against the currently subscribed
    /// set and adjusts `{actor}/state` subscriptions accordingly. Idempotent.
    private func resyncActorStateSubscriptions(
        mqtt: MQTTService,
        teamID: String,
        store: ConnectedAgentsStore?
    ) async {
        let desired: Set<String> = {
            guard let store else { return [] }
            return Set(store.agents.map(\.id).filter { !$0.isEmpty })
        }()
        // Diagnostic: if `desired` is empty we never subscribe to any actor
        // state topic, which is the single most common reason slash commands
        // never reach the composer popup (the daemon's retained state with
        // availableCommands never gets delivered).
        // Either ConnectedAgentsStore hasn't reloaded yet, or an agent
        // arrived with an empty actor id (its routing actor == its id).
        let agentCount = store?.agents.count ?? 0
        let missingActorCount = (store?.agents ?? []).filter {
            $0.id.isEmpty
        }.count
        NSLog("[SessionListVM] resync subs: desired=%d agents=%d missing-actor=%d",
              desired.count, agentCount, missingActorCount)
        let toAdd = desired.subtracting(subscribedActorIDs)
        let toRemove = subscribedActorIDs.subtracting(desired)
        for id in toAdd {
            let actorTopic = MQTTTopics.actorState(teamID: teamID, actorID: id)
            try? await mqtt.subscribe(actorTopic)
            NSLog("[SessionListVM] subscribed to %@", actorTopic)
        }
        for id in toRemove {
            try? await mqtt.unsubscribe(MQTTTopics.actorState(teamID: teamID, actorID: id))
        }
        subscribedActorIDs = desired
    }

    /// Suspends until any tracked property of `store.agents` mutates. Returns
    /// immediately if the store is nil.
    private func waitForAgentsMutation(store: ConnectedAgentsStore?) async {
        guard let store else {
            try? await Task.sleep(for: .seconds(60))
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            withObservationTracking {
                _ = store.agents
            } onChange: {
                cont.resume()
            }
        }
    }

    /// Returns the routing actor-id and runtime-id when `topic` matches
    /// `amux/{team}/{actor}/runtime/{rid}/state` (6 segments). Nil otherwise.
    /// `nonisolated` so the MQTTMessageHub predicate (running on the hub
    /// actor) can call it without hopping to the main actor for what is
    /// pure string-splitting.
    /// Returns the actor-id when `topic` matches `amux/{team}/{actor}/state`
    /// (4 segments) — the one retained topic per actor.
    nonisolated static func parseActorStateTopic(_ topic: String, teamID: String) -> String? {
        let parts = topic.split(separator: "/")
        guard parts.count == 4, parts[0] == "amux", parts[3] == "state" else { return nil }
        let normalizedTeam = MQTTTopics.normalizedTeamID(teamID)
        guard parts[1] == Substring(normalizedTeam) else { return nil }
        return String(parts[2])
    }



    /// Ingest the one retained topic per actor, projecting each attached
    /// session into an `AgentAttachment` row.
    ///
    /// Rows are keyed `(actor, session)`, not by a spawn id. A spawn id is
    /// minted per start and stale the moment it is recorded, whereas exactly
    /// one attachment serves a session per actor at a time.
    ///
    /// A session absent from `live_sessions` is pruned rather than left behind:
    /// absence is the signal for "cold", i.e. the next message will spawn.
    private func syncActorPresence(
        _ presence: Amux_ActorPresence,
        actorID: String,
        modelContext: ModelContext
    ) {
        // Catalogs are keyed by worktree and `LiveSession.worktree` says which
        // one this attachment runs in — a multi-checkout device would otherwise
        // have to guess, which is exactly what the daemon added that field to
        // stop. `catalog_models` is a deduplicated union; `model_indices` are
        // offsets into it (8 worktrees / 563 entries collapse to 72 models).
        let catalogByWorktree = Dictionary(
            presence.worktrees.map { ($0.worktree, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        func models(for catalog: Amux_WorktreeCatalog?) -> [AvailableModel] {
            guard let catalog else { return [] }
            return catalog.modelIndices.compactMap { idx in
                let i = Int(idx)
                guard presence.catalogModels.indices.contains(i) else { return nil }
                let m = presence.catalogModels[i]
                return AvailableModel(id: m.id, displayName: m.displayName)
            }
        }

        var liveIDs: Set<String> = []
        for live in presence.liveSessions where !live.sessionID.isEmpty {
            let id = AgentAttachment.makeID(actorID: actorID, sessionID: live.sessionID)
            liveIDs.insert(id)

            let catalog = catalogByWorktree[live.worktree]
            let modelsJSON = Self.encodeJSON(models(for: catalog))
            let commandsJSON = Self.encodeJSON((catalog?.availableCommands ?? []).map {
                SlashCommand(name: $0.name, description: $0.description_p, inputHint: $0.inputHint)
            })
            // `default_model` is the worktree's MRU head — a memory of what was
            // last used here, owned by the daemon. Never shadow a live value.
            let resolvedModel = live.currentModel.isEmpty
                ? (catalog?.defaultModel ?? "")
                : live.currentModel

            let descriptor = FetchDescriptor<AgentAttachment>(
                predicate: #Predicate { $0.id == id }
            )
            if let existing = try? modelContext.fetch(descriptor).first {
                if existing.status != Int(live.status.rawValue)
                    || existing.lifecycle != Int(live.lifecycle.rawValue) {
                    existing.lastEventTime = .now
                }
                existing.lifecycle = Int(live.lifecycle.rawValue)
                existing.status = Int(live.status.rawValue)
                existing.agentType = Int(presence.activeAgentType.rawValue)
                existing.stage = live.stage
                existing.errorCode = live.errorCode
                existing.errorMessage = live.errorMessage
                existing.failedStage = live.failedStage
                existing.workspaceID = live.workspaceID
                existing.worktree = live.worktree
                existing.currentModel = resolvedModel.isEmpty ? nil : resolvedModel
                // A cold-spawned attachment publishes an empty catalog until the
                // backend finishes probing; never blow away a known list with it.
                if !modelsJSON.isEmpty { existing.availableModelsJSON = modelsJSON }
                if !commandsJSON.isEmpty { existing.availableCommandsJSON = commandsJSON }
            } else {
                let row = AgentAttachment(
                    actorID: actorID,
                    sessionID: live.sessionID,
                    lifecycle: Int(live.lifecycle.rawValue),
                    status: Int(live.status.rawValue),
                    agentType: Int(presence.activeAgentType.rawValue),
                    stage: live.stage,
                    errorCode: live.errorCode,
                    errorMessage: live.errorMessage,
                    failedStage: live.failedStage,
                    workspaceID: live.workspaceID,
                    worktree: live.worktree,
                    currentModel: resolvedModel.isEmpty ? nil : resolvedModel,
                    availableModelsJSON: modelsJSON,
                    availableCommandsJSON: commandsJSON,
                    lastEventTime: .now
                )
                modelContext.insert(row)
            }
        }

        // Absence from `live_sessions` is the signal for "detached / cold", so
        // prune this actor's rows that the retain no longer lists. Only rows
        // this actor owns — another machine serving the same session has its
        // own row under its own actor id.
        let ownedPrefix = "\(actorID)::"
        let stale = (try? modelContext.fetch(FetchDescriptor<AgentAttachment>()))?.filter {
            $0.id.hasPrefix(ownedPrefix) && !liveIDs.contains($0.id)
        } ?? []
        for row in stale { modelContext.delete(row) }

        try? modelContext.save()
        attachments = (try? modelContext.fetch(
            FetchDescriptor<AgentAttachment>(sortBy: [SortDescriptor(\.lastEventTime, order: .reverse)])
        )) ?? []
    }

    private static func encodeJSON<T: Encodable>(_ value: [T]) -> String {
        guard !value.isEmpty,
              let data = try? JSONEncoder().encode(value),
              let str = String(data: data, encoding: .utf8)
        else { return "" }
        return str
    }


    private func syncWorkspaces(_ infos: [Amux_WorkspaceInfo], modelContext: ModelContext) {
        for proto in infos {
            let id = proto.workspaceID
            let descriptor = FetchDescriptor<Workspace>(predicate: #Predicate { $0.workspaceId == id })
            if let existing = try? modelContext.fetch(descriptor).first {
                existing.path = proto.path
                existing.displayName = proto.displayName
                NSLog("[SessionListVM] updated workspace: %@ (%@)", proto.displayName, id)
            } else {
                modelContext.insert(Workspace(
                    workspaceId: proto.workspaceID,
                    path: proto.path,
                    displayName: proto.displayName
                ))
                NSLog("[SessionListVM] inserted workspace: %@ (%@)", proto.displayName, id)
            }
        }
        do {
            try modelContext.save()
            NSLog("[SessionListVM] save OK")
        } catch {
            NSLog("[SessionListVM] save FAILED: %@", error.localizedDescription)
        }
        let fetched = (try? modelContext.fetch(FetchDescriptor<Workspace>(sortBy: [SortDescriptor(\.displayName)]))) ?? []
        NSLog("[SessionListVM] fetched %d workspaces from SwiftData, setting viewModel.workspaces", fetched.count)
        workspaces = fetched
    }

    private func refreshSessions(modelContext: ModelContext) {
        sessions = (try? modelContext.fetch(FetchDescriptor<Session>(sortBy: [SortDescriptor(\.lastMessageAt, order: .reverse)]))) ?? []
    }

    /// Authoritative session IDs for the active team, fetched from Supabase.
    /// When non-nil, `reloadSessions` prunes any local SwiftData rows whose
    /// `sessionId` isn't in the set — this is how we keep MQTT-retained
    /// session garbage on the shared broker from showing up in the list.
    public var validSessionIDs: Set<String>?

    /// Agent actor-ids whose `runtime/+/state` topic we currently hold an
    /// active subscription on. Mutated only by `resyncActorStateSubscriptions`.
    private var subscribedActorIDs: Set<String> = []

    /// Call this from views when sessions are known to have changed (e.g. after TeamclawService sync).
    public func reloadSessions(modelContext: ModelContext) {
        if let validIDs = validSessionIDs {
            let all = (try? modelContext.fetch(FetchDescriptor<Session>())) ?? []
            var didDelete = false
            for row in all where !validIDs.contains(row.sessionId) {
                modelContext.delete(row)
                didDelete = true
            }
            if didDelete { try? modelContext.save() }
        }
        sessions = (try? modelContext.fetch(FetchDescriptor<Session>(sortBy: [SortDescriptor(\.lastMessageAt, order: .reverse)]))) ?? []
    }

    /// Upsert-only sync from Supabase `workspaces`. Does NOT delete missing
    /// entries — MQTT publishes the authoritative live set; Supabase here
    /// just provides offline-resilient name + path so rows can show a
    /// workspace label even when the daemon hasn't sent a retained state.
    public func syncWorkspaceRecords(_ records: [WorkspaceRecord], modelContext: ModelContext) {
        for record in records {
            let id = record.id
            let descriptor = FetchDescriptor<Workspace>(predicate: #Predicate { $0.workspaceId == id })
            if let existing = try? modelContext.fetch(descriptor).first {
                existing.displayName = record.displayName
                if !record.path.isEmpty { existing.path = record.path }
            } else {
                let new = Workspace(
                    workspaceId: record.id,
                    path: record.path,
                    displayName: record.displayName
                )
                modelContext.insert(new)
            }
        }
        try? modelContext.save()
        workspaces = (try? modelContext.fetch(FetchDescriptor<Workspace>(sortBy: [SortDescriptor(\.displayName)]))) ?? []
    }


    public func syncSessionRecords(_ records: [SessionRecord], modelContext: ModelContext) {
        validSessionIDs = Set(records.map(\.id))

        let existing = (try? modelContext.fetch(FetchDescriptor<Session>())) ?? []
        var byID = Dictionary(uniqueKeysWithValues: existing.map { ($0.sessionId, $0) })

        for record in records {
            let session = byID.removeValue(forKey: record.id) ?? {
                let created = Session(sessionId: record.id)
                modelContext.insert(created)
                return created
            }()

            session.teamId = record.teamID
            session.title = record.title
            session.createdBy = record.createdByActorID
            session.createdAt = record.createdAt
            session.summary = record.summary
            session.participantCount = record.participantCount
            session.lastMessagePreview = record.lastMessagePreview
            session.lastMessageAt = record.lastMessageAt
            session.ideaId = record.ideaID ?? ""
            session.primaryAgentId = record.primaryAgentID
        }

        for stale in byID.values {
            modelContext.delete(stale)
        }

        try? modelContext.save()
        reloadSessions(modelContext: modelContext)
    }

    // MARK: - Time Grouping

    public var groupedSessions: [SessionGroup] {
        let q = searchText.lowercased()
        let visible = sessions
            .filter { !$0.isArchived }
            .filter { q.isEmpty || $0.title.lowercased().contains(q) }
            .sorted { $0.listDate > $1.listDate }

        let pinned = visible.filter { $0.isPinned }
        let unpinned = visible.filter { !$0.isPinned }

        var groups: [SessionGroup] = []
        if !pinned.isEmpty {
            groups.append(SessionGroup(id: "pinned", title: "Pinned", items: pinned))
        }

        let calendar = Calendar.current
        let now = Date()

        var today: [Session] = []
        var yesterday: [Session] = []
        var thisWeek: [Session] = []
        var thisMonth: [Session] = []
        var older: [Session] = []

        for item in unpinned {
            let date = item.listDate
            if calendar.isDateInToday(date) {
                today.append(item)
            } else if calendar.isDateInYesterday(date) {
                yesterday.append(item)
            } else if let weekAgo = calendar.date(byAdding: .day, value: -7, to: now), date > weekAgo {
                thisWeek.append(item)
            } else if let monthAgo = calendar.date(byAdding: .month, value: -1, to: now), date > monthAgo {
                thisMonth.append(item)
            } else {
                older.append(item)
            }
        }

        if !today.isEmpty { groups.append(SessionGroup(id: "today", title: "Today", items: today)) }
        if !yesterday.isEmpty { groups.append(SessionGroup(id: "yesterday", title: "Yesterday", items: yesterday)) }
        if !thisWeek.isEmpty { groups.append(SessionGroup(id: "week", title: "This Week", items: thisWeek)) }
        if !thisMonth.isEmpty { groups.append(SessionGroup(id: "month", title: "This Month", items: thisMonth)) }
        if !older.isEmpty { groups.append(SessionGroup(id: "older", title: "Older", items: older)) }

        return groups
    }
}
