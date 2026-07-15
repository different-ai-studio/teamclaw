import Foundation
import Observation
import SwiftData

public struct SlashCommand: Identifiable, Equatable, Hashable, Sendable, Codable {
    public let name: String
    public let description: String
    public let inputHint: String   // "" = no input required
    public var id: String { name }

    public init(name: String, description: String, inputHint: String) {
        self.name = name
        self.description = description
        self.inputHint = inputHint
    }
}

@Observable @MainActor
public final class SessionDetailViewModel {
    public var events: [AgentEvent] = []
    /// Slash commands announced by the attached runtime via
    /// ACP `AvailableCommandsUpdate`. Replaced wholesale on each push.
    /// In-memory only — not persisted to SwiftData. Empty until the
    /// agent's `AvailableCommandsUpdate` lands (or its retained state
    /// topic is consumed), at which point `availableCommands` switches
    /// from the built-in fallback set to the agent-provided list.
    private var dynamicAvailableCommands: [SlashCommand] = []

    /// Slash commands surfaced to the composer popup. Returns the
    /// agent-provided list when the runtime has announced any; otherwise
    /// returns a small built-in set so `/` always shows something useful
    /// (the most common Claude Code built-ins). The composer's
    /// `recomputeSlashCandidates` re-runs whenever this changes.
    public var availableCommands: [SlashCommand] {
        if !dynamicAvailableCommands.isEmpty {
            return dynamicAvailableCommands
        }
        return Self.builtInSlashCommands
    }

    /// Universal fallback so the popup is usable before (or instead of)
    /// the agent emitting `AvailableCommandsUpdate`. Names match Claude
    /// Code's built-ins; sending one forwards the literal `/name` text to
    /// the agent which interprets it natively.
    static let builtInSlashCommands: [SlashCommand] = [
        SlashCommand(name: "clear", description: "Clear conversation history", inputHint: ""),
        SlashCommand(name: "compact", description: "Compact the conversation", inputHint: ""),
        SlashCommand(name: "help", description: "Show available commands", inputHint: ""),
        SlashCommand(name: "model", description: "Switch the active model", inputHint: ""),
        SlashCommand(name: "cost", description: "Show session token cost", inputHint: ""),
    ]
    /// Memoised tool-run grouping over `events`. Views should iterate this
    /// instead of calling `groupEvents(vm.events)` in body, which previously
    /// made grouping O(n) on every streaming delta frame. Recomputed by
    /// `recomputeGroups()` at each mutation site.
    public private(set) var groupedEvents: [GroupedEvent] = []
    /// Higher-level feed grouping that hides per-turn runtime detail
    /// (thinking / tool_use / tool_result) behind active-stream cards or
    /// completed-turn bubbles. Source for the main chat list. Detail view
    /// reads `runtimeEvents` off each item to render the full turn.
    public private(set) var feedItems: [FeedItem] = []
    /// True after `start(modelContext:)` has loaded the initial local event
    /// snapshot and projected it into `feedItems`. The detail view uses this
    /// to reveal the scroll view only after the first real layout pass can
    /// anchor against actual content.
    public private(set) var hasLoadedInitialFeed: Bool = false
    /// Per-agent streaming output buffer. Keyed by the agent actor id. An
    /// entry exists only between the first delta of an `output` stream and
    /// its `isComplete` event (or an idle status flush). Concurrent agents
    /// each get their own slot so multi-agent sessions don't smash a single
    /// buffer. Read for the active-stream card's last-line preview and the
    /// streaming detail view's full text. Empty string for "no active
    /// stream for this agent."
    public private(set) var streamingTextByAgent: [String: String] = [:]
    /// Per-agent model id stamped by the daemon on the most recent streaming
    /// `output` delta. Used so the synthesized event in stop()/idle flush
    /// carries the model that produced the partial text.
    private var streamingModelByAgent: [String: String] = [:]
    /// Set of agents whose `output` stream is in flight (first delta seen,
    /// no `isComplete` yet). Drives the active-stream-card visibility and
    /// the legacy `isStreaming` / `streamingText` shims.
    public private(set) var streamingAgentSet: Set<String> = []
    /// Per-agent active turn id captured at the first delta. The MQTT
    /// subscribe loop reads this on reconnect to replay any envelopes
    /// (incl. the trailing `status_change=idle`) the broker may have
    /// dropped while we were disconnected. Without that replay the
    /// active-stream card hangs until pull-to-refresh.
    private var streamingTurnIDByAgent: [String: String] = [:]
    /// Pending throttled mirror of the reducer's streaming buffers onto
    /// the @Observable fields above. Non-nil while a flush is scheduled;
    /// see `scheduleStreamingMirrorFlush()`.
    private var streamingMirrorFlushTask: Task<Void, Never>?
    /// Agents with an in-flight cancel awaiting the daemon's
    /// `statusChange:.idle` acknowledgment. Membership blocks duplicate
    /// cancels; resolved by the idle event or the ack-timeout fallback.
    public private(set) var interruptPendingAgents: Set<String> = []
    /// Per-agent ack-timeout fallbacks armed by `interruptAgent`. The
    /// daemon normally answers a cancel with `statusChange:.idle` within
    /// a second; when that never arrives (broker drop, runtime wedge,
    /// or an ACP host that ignores session/cancel — opencode does), the
    /// timeout synthesizes the idle locally so the stream still settles
    /// and the partial text still lands. The desktop client has no such
    /// fallback and hangs forever — don't copy that.
    private var interruptTimeoutTasks: [String: Task<Void, Never>] = [:]
    private let interruptAckTimeout: TimeInterval = 8
    /// Backwards-compat shim for callers that haven't migrated to the
    /// per-agent map. True when ANY agent is streaming raw text. Most call
    /// sites should prefer `streamingAgentSet` for correct multi-agent
    /// behavior.
    public var isStreaming: Bool { !streamingAgentSet.isEmpty }
    /// Backwards-compat shim. Returns the streaming text of an arbitrary
    /// active agent — adequate for single-agent sessions; multi-agent UI
    /// must read `streamingTextByAgent[agentID]` directly.
    public var streamingText: String {
        guard let agentID = streamingAgentSet.first else { return "" }
        return streamingTextByAgent[agentID] ?? ""
    }
    public var isDaemonOnline = true

    // MARK: - Phase 4 reducer state
    //
    // `ChatTimelineReducer` is now the source of truth for entry
    // mutations. Inline handlers translate each event arrival into a
    // `TimelineInput`, apply the reducer, mirror the reducer's
    // streaming-buffer state into the VM's @Observable fields, then
    // project entries into the SwiftData-backed `events` array via
    // `TimelineSwiftDataSync.sync`. The view continues to read `events`
    // / `streamingTextByAgent` exactly as before.
    private var timelineState = TimelineState()
    /// User-visible transient error from the most recent send-prompt
    /// attempt. Set by `sendPrompt` when `TeamclawService.sendMessage`
    /// throws; auto-cleared after `errorMessageTTL` seconds. The UI binds
    /// to this for an inline banner so silent publish failures stop being
    /// invisible.
    public var sendErrorMessage: String?
    private var errorClearTask: Task<Void, Never>?
    private let errorMessageTTL: TimeInterval = 5
    public var runtime: Runtime?
    public let session: Session?
    private let mqtt: MQTTService
    private let hub: MQTTMessageHub
    private let teamID: String
    private let peerId: String
    private let teamclawService: TeamclawService?
    private let connectedAgentsStore: ConnectedAgentsStore?
    private let sessionsRepository: SessionRepository?
    private let agentRuntimesRepository: AgentRuntimesRepository?
    private let messagesRepository: MessagesRepository?
    private let workspacesRepository: (any WorkspaceRepository)?
    /// `nonisolated(unsafe)` so the deinit (which runs in a nonisolated
    /// context) can cancel the MQTT subscription task on VM teardown.
    /// Writes happen only from main-actor methods (`start`, `stop`); the
    /// deinit's read happens after all strong references are gone, so the
    /// data-race waiver here is safe in practice.
    // `nonisolated(unsafe)` (not plain `nonisolated`): this is a mutable stored
    // property on an @Observable type, where plain `nonisolated` is rejected.
    // The deinit read is safe in practice (see the note above).
    nonisolated(unsafe) private var task: Task<Void, Never>?
    /// Actor IDs for which this session-detail view has added an MQTT
    /// runtime-state subscription (beyond what SessionListViewModel manages
    /// for ConnectedAgentsStore agents). Tracked so we can unsubscribe on stop().
    private var sessionAgentSubscribedActorIDs: Set<String> = []

    // MARK: - Chip-bar state
    /// Agent actors currently selected in the chip bar. Empty = no specific
    /// mention; all agents will receive the message (broadcast semantics on
    /// the daemon side). Populated by bootstrapChips / toggleAgentChip.
    public private(set) var agentChipSelection: Set<String> = []
    /// Session + context bound together; both are always set or neither is.
    private var sessionBinding: (session: Session, modelContext: ModelContext)?
    /// Ordered list of agent participants shown in the chip bar. Populated
    /// by bootstrapChips from the session's participant list + runtime states.
    public private(set) var agentChipParticipants: [AgentChipParticipant] = []

    // Expose for child views that need to pass these along
    public var mqttRef: MQTTService { mqtt }
    public var hubRef: MQTTMessageHub { hub }
    public var peerIdRef: String { peerId }
    public var teamIDRef: String { teamID }
    public var currentHumanActorIDRef: String? { teamclawService?.currentHumanActorId }
    /// Route actor id resolved from session/runtime context. Empty when
    /// no daemon mapping is available yet (e.g. ConnectedAgentsStore still
    /// loading and runtime row hasn't received state). Callers that need it
    /// for an MQTT publish should bail when empty.
    public var routeActorIDRef: String { resolveRouteActorID() }

    public var sessionTitle: String {
        if let runtime, !runtime.sessionTitle.isEmpty { return runtime.sessionTitle }
        if let runtime {
            let wt = runtime.worktree
            if !wt.isEmpty {
                let last = wt.split(separator: "/").last.map(String.init) ?? wt
                if last != "." { return last }
            }
            return runtime.runtimeId
        }
        if let session, !session.title.isEmpty { return session.title }
        return "Session"
    }

    public var isActive: Bool { runtime?.isActive ?? false }
    public var isIdle: Bool { runtime?.isIdle ?? true }

    /// Heartbeat-style "agent is currently doing something" flag. Source
    /// of truth for the chip-bar's stop button and any other UI that
    /// needs the full agent-busy window (thinking + tool_use + output).
    /// Why a separate flag: `runtime?.isActive` is unreliable for
    /// session-based detail views (often nil) and some ACP backends
    /// don't flip Active reliably between turns. `isStreaming` only
    /// covers raw text deltas and misses the thinking + tool_use phases.
    /// This flag flips on any ACP event arrival or sendPrompt, and
    /// clears on `statusChange:.idle` or after 10s of silence.
    public private(set) var isAgentWorking: Bool = false
    private var agentWorkingResetTask: Task<Void, Never>?
    private var inFlightPermissionRequestIDs: Set<String> = []
    // `nonisolated(unsafe)` required: mutable stored property on an @Observable
    // type, where plain `nonisolated` is rejected by the compiler.
    nonisolated(unsafe) private var spawningPollTask: Task<Void, Never>?
    /// Number of consecutive 2s polls fired while waiting for at least one
    /// agent to leave .spawning / nil-runtimeID state. Reset to 0 whenever
    /// the state settles (no agents need polling). Capped at `maxSpawningPolls`
    /// to avoid burning Supabase reads forever if the daemon dies mid-spawn.
    private var spawningPollCount: Int = 0
    private let maxSpawningPolls: Int = 20
    /// True while a `withObservationTracking` registration for the bound
    /// runtime's `status` / `currentModel` is active. One-shot per fire —
    /// `refreshMemberSheet` re-registers after each onChange.
    private var isObservingRuntimeChanges = false
    public var participantCount: Int { session?.participantCount ?? 0 }
    public var hasRuntime: Bool { runtime != nil }

    /// Bucket key for AgentEvent storage. Multiple sessions sharing a single
    /// daemon agent identity (Runtime.runtimeId == daemon's Supabase actor_id
    /// — see resolveRuntime) would otherwise collide their event histories
    /// under one shared agentId, leaking session N-1's prompts/replies into
    /// session N's view. When a session is in scope we key by session_id;
    /// the legacy runtime-only path (no session) keeps using runtime.runtimeId.
    private var eventScopeKey: String {
        if let session, !session.sessionId.isEmpty { return session.sessionId }
        return runtime?.runtimeId ?? ""
    }

    /// Background sender that drains queued OutboxMessage rows. Injected
    /// by the view layer once it has both the live ModelContainer and a
    /// TeamclawService in scope. nil when this VM was constructed for a
    /// runtime-only legacy path (no session, no Teamclaw) where the
    /// outbox isn't applicable.
    public var outboxSender: OutboxSender?

    public init(runtime: Runtime?,
                mqtt: MQTTService,
                hub: MQTTMessageHub,
                teamID: String = "",
                peerId: String,
                session: Session? = nil,
                teamclawService: TeamclawService? = nil,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                sessionsRepository: SessionRepository? = nil,
                agentRuntimesRepository: AgentRuntimesRepository? = nil,
                messagesRepository: MessagesRepository? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                outboxSender: OutboxSender? = nil) {
        self.runtime = runtime; self.mqtt = mqtt; self.hub = hub; self.teamID = teamID; self.peerId = peerId
        self.session = session; self.teamclawService = teamclawService
        self.connectedAgentsStore = connectedAgentsStore
        self.sessionsRepository = sessionsRepository
        self.agentRuntimesRepository = agentRuntimesRepository
        self.messagesRepository = messagesRepository
        self.workspacesRepository = workspacesRepository
        self.outboxSender = outboxSender
    }

    /// Resolves the routing actor id for the current runtime/session.
    /// Preference order:
    ///   1. ConnectedAgentsStore lookup keyed by `session.primaryAgentId` —
    ///      authoritative when the session is iOS-Supabase-created.
    ///   2. The runtime row's stored `routeActorID` (populated by
    ///      SessionListVM from the topic path it received the state on).
    /// Returns an empty string when no daemon mapping is known yet — callers
    /// should treat that as "skip publish, retry later".
    private func resolveRouteActorID() -> String {
        if let primary = session?.primaryAgentId,
           !primary.isEmpty,
           let agent = connectedAgentsStore?.agents.first(where: { $0.id == primary }),
           !agent.id.isEmpty {
            return agent.id
        }
        if let runtime, !runtime.routeActorID.isEmpty {
            return runtime.routeActorID
        }
        return ""
    }

    /// Resolves the live `Runtime` row that backs this session. Delegates
    /// to `RuntimeResolver` (in AMUXCore/Runtimes) for the actual rule;
    /// this wrapper caches the result onto `self.runtime` so subsequent
    /// calls in the same view session return the same instance.
    private func resolveRuntime(modelContext: ModelContext) -> Runtime? {
        let resolved = RuntimeResolver.resolve(existing: runtime,
                                               session: session,
                                               modelContext: modelContext)
        if runtime == nil, let resolved {
            runtime = resolved
        }
        return resolved
    }

    /// Rebuilds `groupedEvents` from `events`. Call after any mutation that
    /// adds, removes, or reorders events, or changes the grouping-relevant
    /// fields on an existing event (eventType, isComplete, toolId).
    private func recomputeGroups() {
        groupedEvents = groupEvents(events)
        // Union the delta-driven `streamingAgentSet` with the computed
        // `streamingAgentIDs` (which also covers `isAgentWorking`) so the
        // active-stream card surfaces as soon as `markAgentWorking()` flips
        // on send — without waiting for the first ACP runtime event to
        // round-trip via MQTT. Before this union the card only appeared
        // once a real delta arrived, which could take seconds on a
        // cold-spawn agent.
        feedItems = buildFeedItems(
            events,
            streamingAgentIDs: streamingAgentSet.union(streamingAgentIDs)
        )
    }

    private func sortEventsForDisplay() {
        events.sort {
            if $0.timestamp != $1.timestamp { return $0.timestamp < $1.timestamp }
            if $0.sequence != $1.sequence { return $0.sequence < $1.sequence }
            return $0.id < $1.id
        }
        rebuildIndexes()
    }

    private func pruneDuplicateRuntimeEvents(modelContext: ModelContext) {
        struct Candidate {
            let index: Int
            let score: Int
        }

        var bestByKey: [String: Candidate] = [:]
        var duplicateIndexes = Set<Int>()

        for (index, event) in events.enumerated() {
            guard event.sequence > 0, event.eventType != "user_prompt" else { continue }
            let key = [
                String(event.sequence),
                event.eventType,
                event.senderActorID ?? "",
                event.toolId ?? "",
                event.text ?? ""
            ].joined(separator: "\u{1f}")
            let score = (event.supabaseMessageId == nil ? 0 : 4)
                + (event.isComplete ? 2 : 0)
                + (event.success == nil ? 0 : 1)

            if let current = bestByKey[key] {
                if score > current.score {
                    duplicateIndexes.insert(current.index)
                    bestByKey[key] = Candidate(index: index, score: score)
                } else {
                    duplicateIndexes.insert(index)
                }
            } else {
                bestByKey[key] = Candidate(index: index, score: score)
            }
        }

        for (index, event) in events.enumerated() {
            guard event.eventType == "output",
                  event.supabaseMessageId == nil,
                  event.turnID == nil,
                  let text = event.text,
                  !text.isEmpty
            else { continue }

            let hasFullPersistedReply = events.contains { other in
                guard other.id != event.id,
                      other.eventType == "output",
                      other.supabaseMessageId != nil,
                      (other.senderActorID ?? "") == (event.senderActorID ?? ""),
                      let fullText = other.text,
                      text.count < fullText.count,
                      fullText.hasPrefix(text),
                      event.timestamp >= other.timestamp
                else { return false }
                return true
            }
            if hasFullPersistedReply {
                duplicateIndexes.insert(index)
            }
        }

        guard !duplicateIndexes.isEmpty else { return }
        for index in duplicateIndexes.sorted(by: >) {
            modelContext.delete(events[index])
            events.remove(at: index)
        }
        try? modelContext.save()
    }

    // MARK: - Chip-bar bootstrap + selection

    /// Populate chip participants from the session's participant list and
    /// current runtime states. Call this after the session's participant
    /// rows have been resolved (e.g. from Supabase) and the connected-
    /// agents store has been queried for runtime state.
    ///
    /// Selection heuristic (Q7=c): if exactly one agent participates, pre-
    /// select it so the first send is automatically directed at that agent.
    /// Multi-agent sessions start with empty selection (broadcast mode).
    public func bootstrapChips(
        participants: [SessionParticipant],
        runtimeStates: [String: AgentRuntimeChipState],
        legacyPrimaryAgentID: String? = nil
    ) {
        var agents = participants.filter { $0.role == "agent" }

        // Compatibility: if the session has no agent participants but a legacy
        // primary_agent_id, synthesize one chip for that agent so the chat is
        // still routable.
        if agents.isEmpty, let primary = legacyPrimaryAgentID, !primary.isEmpty {
            agents = [SessionParticipant(actorID: primary, role: "agent", displayName: nil)]
        }

        self.agentChipParticipants = agents.map {
            AgentChipParticipant(
                id: $0.actorID,
                displayName: $0.displayName ?? String($0.actorID.prefix(8)),
                runtimeState: runtimeStates[$0.actorID] ?? .spawning
            )
        }

        // Bound session: persistence is the source of truth (already hydrated
        // in `bind`). Leave selection alone — even an empty value is the user's
        // explicit choice.
        guard sessionBinding == nil else { return }

        // Unbound (new session before persistence is wired up): apply the legacy
        // single-agent default.
        self.agentChipSelection = agents.count == 1 ? Set([agents[0].actorID]) : []
    }

    /// Toggle the selected state of one chip. Called from the chip-bar tap handler.
    public func toggleAgentChip(_ agentID: String) {
        if agentChipSelection.contains(agentID) { agentChipSelection.remove(agentID) }
        else { agentChipSelection.insert(agentID) }
        persistAgentChipSelection()
    }

    /// Ensure an agent's chip is lit. Idempotent — never unlights. Used by
    /// the @-mention picker so picking an agent always engages them; the
    /// chip-bar toolbar above the composer remains the surface for turning
    /// agents off.
    public func lightAgentChip(_ agentID: String) {
        agentChipSelection.insert(agentID)
        persistAgentChipSelection()
    }

    /// Agent actor ids whose runtime is currently streaming a reply. Used
    /// by the chip bar to swap the chip's `×` button for a stop button.
    ///
    /// Today the detail view is anchored on either a bound runtime (legacy
    /// runtime-only init, where viewModel.runtime is non-nil) or a session
    /// (multi-agent init, where runtime is nil and the source of truth is
    /// memberSheetAgents). In the session case we currently lack per-agent
    /// streaming state, so when isStreaming is true we attribute it to the
    /// only agent in the session — adequate for single-agent sessions and
    /// gracefully degrades to the chip-bar's existing default-light rule.
    /// True per-agent streaming attribution is a future-work item that
    /// arrives with multi-agent ACP fanout.
    public var streamingAgentIDs: Set<String> {
        // `isAgentWorking` is the canonical busy signal — flips true on
        // any ACP event arrival (thinking, tool_use, output) and clears
        // on idle. `isActive`/`isStreaming` are kept as fallbacks so the
        // stop button stays up even if the heartbeat flag misses an
        // event for any reason.
        guard isAgentWorking || isActive || isStreaming else { return [] }
        if let boundRuntimeID = runtime?.runtimeId,
           let agent = memberSheetAgents.first(where: { $0.runtimeID == boundRuntimeID }) {
            return [agent.id]
        }
        // Session-based fallback: no bound runtime, so we can't disambiguate
        // among multiple agents. With exactly one agent, attribute the
        // busy state to it. With more, leave empty (chip stays as ×)
        // until per-agent attribution lands.
        if memberSheetAgents.count == 1, let only = memberSheetAgents.first {
            return [only.id]
        }
        return []
    }

    /// Cancel a specific agent's currently-running ACP turn.
    ///
    /// Deliberately does NOT clear any streaming state here. The daemon
    /// answers the cancel with `statusChange:.idle`, and the reducer's
    /// idle path flushes the partial text into a completed entry for
    /// exactly this bucket — clearing optimistically (the old behavior)
    /// discarded everything the user had watched stream in AND wiped
    /// concurrent agents' live buffers via the global markAgentDone().
    /// An 8s ack-timeout synthesizes the idle locally if the daemon
    /// never responds, so the card can't hang forever either.
    public func interruptAgent(_ agentActorID: String) {
        guard !interruptPendingAgents.contains(agentActorID) else { return }
        interruptPendingAgents.insert(agentActorID)
        Task {
            do {
                try await sendCommand(agentActorID: agentActorID) {
                    $0.command = .cancel(Amux_AcpCancel())
                }
                armInterruptAckTimeout(for: agentActorID)
            } catch {
                // sendCommand already surfaced the user-facing error.
                // Keep the stream live so the user can retry the stop.
                interruptPendingAgents.remove(agentActorID)
            }
        }
    }

    /// Prepend `@<displayName> ` for every lit chip whose token isn't
    /// already in the body. Lets the auto-light single-agent default
    /// produce a self-describing message (e.g. "@mini Top 10 news") even
    /// when the user typed only the prompt body. Manual @-picks are
    /// already inserted by the composer, so the contains() check skips
    /// them to avoid double-prepend.
    func composeBodyWithMentions(_ text: String) -> String {
        var body = text
        for agentID in agentChipSelection {
            guard let agent = memberSheetAgents.first(where: { $0.id == agentID }) else { continue }
            let token = "@\(agent.displayName)"
            if !body.localizedCaseInsensitiveContains(token) {
                body = body.isEmpty ? token : "\(token) \(body)"
            }
        }
        return body
    }

    /// Replace the entire chip selection. Used by Task 16 view integration.
    public func setAgentChipSelection(_ selection: Set<String>) {
        self.agentChipSelection = selection
        persistAgentChipSelection()
    }

    // MARK: - Session binding (chip persistence)

    /// Bind a `Session` model and its `ModelContext` so that chip-bar
    /// mutations are persisted to `session.selectedAgentIds`. Also
    /// hydrates `agentChipSelection` from the stored value.
    /// Call this once when the session and model context are both available.
    public func bind(session: Session, modelContext: ModelContext) {
        self.sessionBinding = (session, modelContext)
        self.agentChipSelection = Set(session.selectedAgentIds)
    }

    private func persistAgentChipSelection() {
        guard let binding = sessionBinding else { return }
        binding.session.selectedAgentIds = Array(agentChipSelection).sorted()
        try? binding.modelContext.save()
    }

    /// Drops any agent IDs from `agentChipSelection` that are no longer
    /// present in `memberSheetAgents` (i.e. ghost selections left over from
    /// a removed agent). Persists the pruned set when any IDs were removed.
    private func pruneGhostAgentSelection() {
        let valid = Set(memberSheetAgents.map(\.id))
        let pruned = agentChipSelection.intersection(valid)
        guard pruned.count != agentChipSelection.count else { return }
        agentChipSelection = pruned
        persistAgentChipSelection()
    }

    // MARK: - Member sheet state
    //
    // Snapshot models (MemberSheetHuman / MemberSheetAgent) and the
    // loader/chipState/displayName helpers live in
    // AMUXCore/Sessions/SessionMemberSheetLoader.swift.

    public private(set) var memberSheetHumans: [MemberSheetHuman] = []
    public private(set) var memberSheetAgents: [MemberSheetAgent] = []

    /// Per-agent latest plan_update parsed into a snapshot, filtered to
    /// agents that still have unfinished items. Empty when no agent in the
    /// session has a live plan. The `SessionDetailView` toolbar icon and
    /// `SessionPlansPanelView` both render off this.
    public var activePlanSnapshots: [AgentPlanSnapshot] {
        AgentPlanSnapshot.derive(
            events: events,
            agentNameFor: { [self] id in self.agentDisplayName(actorID: id) }
        )
    }

    private func agentDisplayName(actorID id: String) -> String {
        memberSheetAgents.first(where: { $0.id == id })?.displayName
            ?? String(id.prefix(8))
    }

    /// Refreshes the member sheet data from Supabase. Called by the view
    /// each time the sheet opens. On failure keeps prior values.
    ///
    /// Loading / shaping logic lives in `SessionMemberSheetLoader`;
    /// this method binds the snapshot to the VM and runs the chip-bar
    /// auto-light cross-cutting rule.
    public func refreshMemberSheet() async {
        guard let session, !session.sessionId.isEmpty else { return }
        let loader = SessionMemberSheetLoader(
            sessionsRepository: sessionsRepository,
            agentRuntimesRepository: agentRuntimesRepository
        )
        // Snapshot the bound-runtime model lookup into Sendable locals on the
        // MainActor, then hand the loader a @Sendable closure that touches none
        // of `self`. `availableModels(forAgentActorID:)` only consults the
        // single bound `runtime` + the session's primary agent, so this is
        // behaviourally identical without sending main-actor state into the
        // loader's nonisolated execution.
        let boundRuntimeID = runtime?.runtimeId
        let boundModelIDs = runtime?.availableModels.map(\.id) ?? []
        let primaryAgentID = session.primaryAgentId
        guard let snapshot = await loader.load(
            sessionID: session.sessionId,
            teamID: teamID,
            currentHumanActorID: teamclawService?.currentHumanActorId ?? "",
            availableModelsForAgent: { actorID in
                if let boundRuntimeID, boundRuntimeID == actorID || primaryAgentID == actorID {
                    return boundModelIDs
                }
                return []
            }
        ) else {
            print("[RuntimeDetailVM] refreshMemberSheet: loader returned nil (no repo or fetch failed)")
            return
        }

        memberSheetHumans = snapshot.humans
        memberSheetAgents = snapshot.agents
        pruneGhostAgentSelection()

        // memberSheet now provides runtime_id → actor_id mappings. Live
        // events that arrived before this load may have been stamped with
        // the raw runtime_id (bucketKey's `?? rid` fallback) and frozen
        // there by the resolution cache — see line ~1164. Supabase-seeded
        // history rows are stamped with the canonical actor_id directly,
        // so the two sources end up in two buckets for the same agent
        // and `buildFeedItems` produces duplicate bubbles / a phantom
        // trailing card. Reconcile here by retroactively rewriting the
        // raw stamps to the resolved actor_id.
        relabelRawRuntimeIDStampsToActorIDs()

        // Reconnect replays that couldn't be routed before this roster
        // loaded (actor_id bucket with no runtime_id mapping) get exactly
        // one retry now that the mapping exists.
        await retryPendingTurnReplays()

        // Overlay live MQTT-derived data from the SwiftData Runtime row.
        // Supabase agent_runtimes.current_model is only written on ACP
        // StatusChange events (first prompt reply); MQTT state carries
        // currentModel right after set_session_model() completes (~2-3s
        // after spawn). For session-based views where runtime was nil at
        // start() time, re-resolve here so a Runtime row created by
        // SessionListVM after MQTT arrived isn't missed.
        overlayMQTTRuntimeState()

        // Ensure MQTT subscriptions exist for every session agent so that
        // retained runtime/state messages (carrying availableModels) are
        // delivered even for agents not in ConnectedAgentsStore.
        subscribeToSessionAgentRuntimeStates()

        // While any agent is still spawning OR has no Supabase runtime row
        // yet (just-spawned, row not written), keep polling so the sheet
        // self-updates once state settles — covers the SwiftData onChange
        // chain missing the MQTT ACTIVE transition for non-bound-runtime views.
        scheduleSpawningRefreshIfNeeded()
    }

    /// Re-resolves the bound Runtime (if nil) and overlays its MQTT-derived
    /// chip state + currentModel onto the matching member-sheet agent row.
    /// Also (re-)registers a one-shot observation on the runtime so MQTT
    /// mutations trigger an immediate refresh — removes the 2s polling
    /// latency for state transitions once the Runtime row is known.
    private func overlayMQTTRuntimeState() {
        if runtime == nil, let ctx = startModelContext {
            runtime = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        }
        // Upgrade a transient placeholder to the real SwiftData Runtime row if
        // one has arrived since start(). A placeholder is never inserted into a
        // ModelContext, so `modelContext == nil` identifies it.
        if let ctx = startModelContext,
           let ph = runtime, ph.modelContext == nil, !ph.runtimeId.isEmpty {
            let rid = ph.runtimeId
            let desc = FetchDescriptor<Runtime>(predicate: #Predicate { $0.runtimeId == rid })
            if let real = (try? ctx.fetch(desc))?.first {
                runtime = real
            }
        }
        // Seed slash commands from the (possibly newly resolved) runtime.
        // Covers both: placeholder→real upgrade above and the race where
        // SessionListViewModel writes availableCommandsJSON after start().
        if let cmds = runtime?.availableCommands, !cmds.isEmpty {
            dynamicAvailableCommands = cmds
        }
        guard let liveRuntime = runtime else { return }
        observeBoundRuntimeChanges()

        // Build a runtimeId → SwiftData Runtime lookup for non-primary agents so
        // their MQTT-synced currentModel / state is reflected here too. Without
        // this, only the bound (primary) agent's SwiftData row is read; non-primary
        // agents rely solely on Supabase, which the daemon writes with a brief delay.
        var extraByRID: [String: Runtime] = [:]
        if let ctx = startModelContext {
            let rids = memberSheetAgents.compactMap(\.runtimeID).filter {
                $0 != liveRuntime.runtimeId
            }
            for rid in rids {
                let r = rid
                let desc = FetchDescriptor<Runtime>(predicate: #Predicate { $0.runtimeId == r })
                if let found = try? ctx.fetch(desc).first { extraByRID[rid] = found }
            }
        }

        memberSheetAgents = memberSheetAgents.map { agent in
            // Primary agent: use bound runtime.
            if agent.runtimeID == liveRuntime.runtimeId || session?.primaryAgentId == agent.id {
                return MemberSheetAgent(
                    id: agent.id, displayName: agent.displayName,
                    workspacePath: agent.workspacePath, agentType: agent.agentType,
                    runtimeState: chipStateFromRuntime(liveRuntime),
                    availableModels: {
                        let live = liveRuntime.availableModels.map(\.id)
                        if !live.isEmpty { return live }
                        if !agent.availableModels.isEmpty { return agent.availableModels }
                        return []
                    }(),
                    currentModel: liveRuntime.currentModel ?? agent.currentModel,
                    runtimeID: agent.runtimeID ?? liveRuntime.runtimeId,
                    workspaceID: agent.workspaceID, backendType: agent.backendType
                )
            }
            // Non-primary agent: overlay from their SwiftData Runtime if available.
            if let rid = agent.runtimeID, let extra = extraByRID[rid] {
                return MemberSheetAgent(
                    id: agent.id, displayName: agent.displayName,
                    workspacePath: agent.workspacePath, agentType: agent.agentType,
                    runtimeState: chipStateFromRuntime(extra),
                    availableModels: {
                        let live = extra.availableModels.map(\.id)
                        if !live.isEmpty { return live }
                        if !agent.availableModels.isEmpty { return agent.availableModels }
                        return []
                    }(),
                    currentModel: extra.currentModel ?? agent.currentModel,
                    runtimeID: agent.runtimeID, workspaceID: agent.workspaceID,
                    backendType: agent.backendType
                )
            }
            return agent
        }
        pruneGhostAgentSelection()
    }

    private func chipStateFromRuntime(_ r: Runtime) -> AgentRuntimeChipState {
        switch r.status {
        case 1: return .spawning
        case 2: return .active
        case 3: return .idle
        case 4: return .error
        case 5: return .stopped
        default: return .spawning
        }
    }

    /// Registers a one-shot Observation on the bound runtime's `status` and
    /// `currentModel`. When SwiftData propagates a mutation (driven by
    /// SessionListVM's MQTT retained-state ingest), fire a refresh so the
    /// member sheet self-updates without waiting for the 2s poll tick.
    /// `refreshMemberSheet` calls back into `overlayMQTTRuntimeState`, which
    /// re-invokes this method — so the next change is observed too.
    private func observeBoundRuntimeChanges() {
        guard !isObservingRuntimeChanges, let runtime else { return }
        isObservingRuntimeChanges = true
        withObservationTracking {
            _ = runtime.status
            _ = runtime.currentModel
            _ = runtime.availableCommandsJSON
            _ = runtime.availableModels      // MQTT 更新 models 时触发 refresh
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.isObservingRuntimeChanges = false
                if let cmds = self?.runtime?.availableCommands, !cmds.isEmpty {
                    self?.dynamicAvailableCommands = cmds
                }
                await self?.refreshMemberSheet()
            }
        }
    }

    /// Ensures MQTT runtime-state subscriptions exist for every agent in the
    /// current session, not just those already in ConnectedAgentsStore.
    /// SessionListViewModel covers ConnectedAgentsStore agents; this method
    /// patches the gap for agents owned by other daemons / team members.
    ///
    /// Call this after `memberSheetAgents` is populated. When a new retained
    /// runtime/state message arrives, SessionListViewModel's hub predicate
    /// picks it up and writes models into SwiftData, and the subsequent
    /// `refreshMemberSheet` call from `scheduleSpawningRefreshIfNeeded`
    /// surfaces them via `overlayMQTTRuntimeState`.
    private func subscribeToSessionAgentRuntimeStates() {
        guard let ctx = startModelContext, !teamID.isEmpty else { return }
        var toSubscribe: Set<String> = []
        for agent in memberSheetAgents {
            guard let rid = agent.runtimeID, !rid.isEmpty else { continue }
            // Look up the routeActorID from the SwiftData Runtime row.
            let r = rid
            let desc = FetchDescriptor<Runtime>(predicate: #Predicate { $0.runtimeId == r })
            guard let routeActorID = (try? ctx.fetch(desc))?.first?.routeActorID,
                  !routeActorID.isEmpty else { continue }
            guard !sessionAgentSubscribedActorIDs.contains(routeActorID) else { continue }
            toSubscribe.insert(routeActorID)
        }
        guard !toSubscribe.isEmpty else { return }
        let mqtt = self.mqtt
        let teamID = self.teamID
        Task { [weak self] in
            for actorID in toSubscribe {
                let topic = MQTTTopics.runtimeStateWildcard(teamID: teamID, actorID: actorID)
                try? await mqtt.subscribe(topic)
                NSLog("[SessionDetailVM] subscribed runtime state for extra actor=%@", actorID)
            }
            await self?.onExtraRuntimeSubscriptionsAdded()
        }
        sessionAgentSubscribedActorIDs.formUnion(toSubscribe)
    }

    /// Called after extra MQTT subscriptions are set up. Retained messages
    /// arrive within milliseconds; a short yield lets SessionListViewModel
    /// write to SwiftData before we re-overlay.
    @MainActor
    private func onExtraRuntimeSubscriptionsAdded() async {
        try? await Task.sleep(for: .milliseconds(300))
        overlayMQTTRuntimeState()
    }

    private func scheduleSpawningRefreshIfNeeded() {
        let needsPoll = memberSheetAgents.contains {
            $0.runtimeState == .spawning
            || $0.runtimeID == nil
            || ($0.availableModels.isEmpty
                && ($0.runtimeState == .active
                    || $0.runtimeState == .idle
                    || $0.runtimeState == .ready))
        }
        if needsPoll, spawningPollCount < maxSpawningPolls {
            guard spawningPollTask == nil else { return }
            spawningPollCount += 1
            spawningPollTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                self?.spawningPollTask = nil
                await self?.refreshMemberSheet()
            }
        } else {
            spawningPollTask?.cancel()
            spawningPollTask = nil
            if !needsPoll {
                // State settled — reset so the next fresh spawn gets a
                // full budget of polls (covers e.g. addAgent later in the
                // same session view).
                spawningPollCount = 0
            }
        }
    }

    /// Best-effort lookup of model ids for the chosen agent actor. Falls back
    /// to the bound `runtime.availableModels` (loaded by SessionListVM from the
    /// MQTT runtime/{id}/state retained topic) when it matches the agent.
    private func availableModels(forAgentActorID actorID: String) -> [String] {
        if let runtime, runtime.runtimeId == actorID || session?.primaryAgentId == actorID {
            return runtime.availableModels.map(\.id)
        }
        return []
    }

    /// Union of human + agent actor ids currently in the session, used by
    /// add-member / add-agent sheets to hide rows for participants already in.
    public var existingParticipantActorIDs: Set<String> {
        Set(memberSheetHumans.map(\.id)).union(memberSheetAgents.map(\.id))
    }

    /// Returns the ConnectedAgent rows the caller can pick from when adding a
    /// new agent to the session. Filters out the agents already participating
    /// so the picker shows only fresh candidates. Empty when the store hasn't
    /// loaded yet.
    public func candidatesForAddAgent() -> [ConnectedAgent] {
        let existing = existingParticipantActorIDs
        let agents = connectedAgentsStore?.agents ?? []
        return agents.filter { !existing.contains($0.id) }
    }

    /// Adds humans to the session via `session_participants`, then refreshes
    /// the member sheet so the new rows show up.
    public func addMembers(_ actorIDs: [String]) async {
        guard let session, !actorIDs.isEmpty else { return }
        let sessionID = session.sessionId
        guard !sessionID.isEmpty else { return }

        let sessionsRepo = self.sessionsRepository
        guard let sessionsRepo else {
            print("[RuntimeDetailVM] addMembers: no sessions repo available")
            return
        }
        do {
            try await sessionsRepo.addParticipants(sessionID: sessionID, actorIDs: actorIDs)
        } catch {
            print("[RuntimeDetailVM] addMembers: addParticipants failed: \(error)")
            // Fall through — refreshMemberSheet will still re-pull truth.
        }
        await refreshMemberSheet()
    }

    /// Adds an agent to the session and starts a runtime for it on the agent's
    /// daemon. Order matches NewSessionSheet's flow: insert participant first,
    /// then RPC into the daemon to spawn its runtime, then refresh the sheet.
    public func addAgent(actorID: String,
                         workspaceID: String,
                         worktreePath: String,
                         agentType: Amux_AgentType) async {
        guard let session else { return }
        let sessionID = session.sessionId
        guard !sessionID.isEmpty else { return }

        let sessionsRepo = self.sessionsRepository
        if let sessionsRepo {
            do {
                try await sessionsRepo.addParticipants(sessionID: sessionID, actorIDs: [actorID])
            } catch {
                print("[RuntimeDetailVM] addAgent: addParticipants failed: \(error)")
            }
        } else {
            print("[RuntimeDetailVM] addAgent: no sessions repo available")
        }

        // Resolve the routing actor id for this agent actor so the
        // runtime-start RPC reaches the right daemon. ConnectedAgentsStore
        // is the authoritative source — same lookup NewSessionSheet uses.
        guard let routeActor = routeActorID(forAgentActorID: actorID), !routeActor.isEmpty else {
            print("[RuntimeDetailVM] addAgent: no route actor id for agent actor \(actorID)")
            await refreshMemberSheet()
            return
        }

        // Refresh once so the agent row appears (participant row just
        // written), then immediately flip it to .spawning so the sheet
        // shows a spinner for the ~1-3s that the RPC + ACP spawn takes.
        // The Supabase agent_runtimes row won't exist yet at this point,
        // so without the optimistic patch the row would show "default".
        spawningPollCount = 0
        await refreshMemberSheet()
        if let idx = memberSheetAgents.firstIndex(where: { $0.id == actorID }) {
            let cur = memberSheetAgents[idx]
            memberSheetAgents[idx] = MemberSheetAgent(
                id: cur.id, displayName: cur.displayName,
                workspacePath: cur.workspacePath, agentType: cur.agentType,
                runtimeState: .spawning, availableModels: cur.availableModels,
                currentModel: cur.currentModel, runtimeID: cur.runtimeID,
                workspaceID: cur.workspaceID, backendType: cur.backendType
            )
        }

        if let teamclawService {
            let outcome = await teamclawService.runtimeStartRpc(
                targetActorID: routeActor,
                agentType: agentType,
                workspaceId: workspaceID,
                worktree: worktreePath,
                sessionId: sessionID,
                initialPrompt: ""
            )
            if case .rejected(let reason) = outcome {
                print("[RuntimeDetailVM] addAgent: runtimeStart rejected: \(reason)")
            }
        } else {
            print("[RuntimeDetailVM] addAgent: no teamclawService configured")
        }

        await refreshMemberSheet()
    }

    /// Removes a human participant from this session.
    ///
    /// Supabase is the source of truth — delete the row first, then refresh
    /// the sheet so the UI reflects the new state. Peer realtime fanout to
    /// other clients is future work (open question: there's no obvious single
    /// daemon to RPC for human-only removal; the daemon's
    /// `handle_remove_participant` only updates its local cache + notify
    /// channel anyway, so for now we rely on each client's own Supabase poll).
    public func removeHuman(_ actorID: String) {
        Task { [weak self] in
            guard let self,
                  let sessionID = self.session?.sessionId,
                  !sessionID.isEmpty else { return }

            let sessionsRepo = self.sessionsRepository
            if let sessionsRepo {
                do {
                    try await sessionsRepo.removeParticipant(sessionID: sessionID, actorID: actorID)
                } catch {
                    print("[RuntimeDetailVM] removeHuman: removeParticipant failed: \(error)")
                }
            } else {
                print("[RuntimeDetailVM] removeHuman: no sessions repo available")
            }

            await self.refreshMemberSheet()
        }
    }

    /// Restarts an agent's runtime in the current session: best-effort Stop
    /// of the existing daemon subprocess followed by a fresh Start RPC in the
    /// same workspace + agent type. The daemon writes a new `agent_runtimes`
    /// row (or updates the existing one — its choice); `refreshMemberSheet`
    /// at the end re-pulls truth so the UI catches up.
    ///
    /// Edge cases:
    ///  - No `routeActorID` (agent's daemon offline): bail with a warning;
    ///    restart isn't possible without a live daemon.
    ///  - No `runtimeID` (runtime never spawned, or already stopped): skip
    ///    the Stop and go straight to Start.
    ///  - Empty / unresolvable worktree path: try Start anyway. The daemon
    ///    rejects with a clean error rather than us pre-validating.
    public func restartRuntime(forAgent actorID: String) {
        Task { [weak self] in
            guard let self,
                  let sessionID = self.session?.sessionId,
                  !sessionID.isEmpty,
                  let row = self.memberSheetAgents.first(where: { $0.id == actorID })
            else { return }

            guard let routeActorID = self.routeActorID(forAgentActorID: actorID),
                  !routeActorID.isEmpty
            else {
                print("[RuntimeDetailVM] restartRuntime: no route actor id for agent actor \(actorID); aborting")
                return
            }

            guard let teamclawService = self.teamclawService else {
                print("[RuntimeDetailVM] restartRuntime: no teamclawService configured")
                return
            }

            // 1. Stop existing runtime. Best-effort; if it's already gone the
            //    Start below will still do the right thing.
            if let runtimeID = self.runtimeID(forAgentActorID: actorID),
               !runtimeID.isEmpty {
                let (ok, err) = await teamclawService.runtimeStopRpc(
                    targetActorID: routeActorID,
                    runtimeID: runtimeID
                )
                if !ok {
                    print("[RuntimeDetailVM] restartRuntime: runtimeStop failed: \(err) — proceeding to start")
                }
            } else {
                print("[RuntimeDetailVM] restartRuntime: no runtime id for actor \(actorID); skipping stop")
            }

            // 2. Resolve the worktree filesystem path. `MemberSheetAgent`
            //    holds the workspace UUID (not a path) under both
            //    `workspaceID` and the legacy `workspacePath` field, so
            //    look it up against Supabase the same way `AddAgentSheet`
            //    does. Empty path falls through — the daemon rejects with
            //    a clean error.
            let workspaceID = row.workspaceID ?? row.workspacePath
            let worktreePath = await self.resolveWorkspacePath(
                workspaceID: workspaceID,
                agentActorID: actorID
            )

            // 3. Spawn a new runtime in the same workspace + same agent type.
            let agentType = Self.amuxAgentType(forBackendType: row.backendType)
            let outcome = await teamclawService.runtimeStartRpc(
                targetActorID: routeActorID,
                agentType: agentType,
                workspaceId: workspaceID,
                worktree: worktreePath,
                sessionId: sessionID,
                initialPrompt: ""
            )
            if case .rejected(let reason) = outcome {
                print("[RuntimeDetailVM] restartRuntime: runtimeStart rejected: \(reason)")
            }

            await self.refreshMemberSheet()
        }
    }

    /// Maps the `agent_runtimes.backend_type` string to the proto enum
    /// `runtimeStartRpc` expects. Mirrors the AMUXUI-side
    /// `AgentConfigSheet.AgentType.asAmuxAgentType` mapping; we duplicate it
    /// here because that helper lives in the UI package and can't be
    /// imported from AMUXCore.
    private static func amuxAgentType(forBackendType backendType: String?) -> Amux_AgentType {
        switch backendType {
        case "claude": return .claudeCode
        case "opencode": return .opencode
        case "codex": return .codex
        default: return .claudeCode
        }
    }

    /// Best-effort lookup of the worktree filesystem path for a workspace UUID.
    /// Uses the injected Cloud API `WorkspaceRepository`, narrowed to the agent's
    /// own workspaces first (matching `AddAgentSheet`'s default), then widened
    /// to all team workspaces if the agent-scoped query yielded nothing.
    /// Returns "" when the path can't be resolved — the daemon will reject
    /// with a clean error rather than us pre-validating here.
    private func resolveWorkspacePath(workspaceID: String, agentActorID: String) async -> String {
        guard !workspaceID.isEmpty, !teamID.isEmpty else { return "" }
        guard let repo = workspacesRepository else { return "" }

        if let agentScoped = try? await repo.listWorkspaces(teamID: teamID, agentID: agentActorID),
           let hit = agentScoped.first(where: { $0.id == workspaceID }) {
            return hit.path
        }
        if let allScoped = try? await repo.listWorkspaces(teamID: teamID, agentID: nil),
           let hit = allScoped.first(where: { $0.id == workspaceID }) {
            return hit.path
        }
        return ""
    }

    /// Returns the live SwiftData `Runtime` row for the given agent, or nil
    /// when no runtime row has been loaded yet (e.g. agent still spawning or
    /// the primary bound runtime's runtimeId doesn't match the agent's).
    /// Used by AgentsSheet to drive the model picker without the sheet itself
    /// holding a SwiftData query or accessing internal VM state.
    public func runtime(for agent: MemberSheetAgent) -> Runtime? {
        // Fast path: bound primary runtime's `runtimeId` (UUID) matches this
        // agent's `runtimeID`. UUID collisions across distinct agents are not
        // a practical concern, so id equality implies identity here.
        if let r = runtime, let rid = agent.runtimeID, r.runtimeId == rid { return r }
        // Slow path: fetch from the persistent store by runtimeID.
        guard let rid = agent.runtimeID, !rid.isEmpty,
              let ctx = startModelContext else { return nil }
        let desc = FetchDescriptor<Runtime>(predicate: #Predicate { $0.runtimeId == rid })
        return (try? ctx.fetch(desc))?.first
    }

    /// Switches the model for an agent's runtime. The daemon's SetModel RPC
    /// updates `current_model_per_agent` and re-publishes the runtime's
    /// retained state, so the member sheet refreshes via the normal state
    /// stream as well — but we still call `refreshMemberSheet` to pick up
    /// any participant-row deltas and to keep parity with the other write
    /// paths (`removeAgent`, `restartRuntime`).
    public func setModel(forAgent actorID: String, model: String) {
        Task { [weak self] in
            guard let self,
                  let teamclawService = self.teamclawService,
                  let runtimeID = self.runtimeID(forAgentActorID: actorID),
                  !runtimeID.isEmpty
            else {
                print("[RuntimeDetailVM] setModel: skipping — no runtimeID for actor=\(actorID)")
                return
            }
            // Resolve route actor id. connectedAgentsStore only contains agents
            // the current user has explicit access to, so non-primary agents added
            // to a session by someone else may not be in the store. Fall back to
            // the bound runtime (primary agent) or a SwiftData fetch by runtimeId.
            let routeActor: String = {
                if let id = self.routeActorID(forAgentActorID: actorID), !id.isEmpty { return id }
                if let r = self.runtime, r.runtimeId == runtimeID, !r.routeActorID.isEmpty {
                    return r.routeActorID
                }
                if let ctx = self.startModelContext {
                    let rid = runtimeID
                    let desc = FetchDescriptor<Runtime>(predicate: #Predicate { $0.runtimeId == rid })
                    return (try? ctx.fetch(desc).first?.routeActorID) ?? ""
                }
                return ""
            }()
            guard !routeActor.isEmpty else {
                print("[RuntimeDetailVM] setModel: skipping — no route actor id for actor=\(actorID)")
                return
            }
            // Apply optimistic update immediately so the UI reflects the choice
            // without waiting for the full RPC + refreshMemberSheet round-trip.
            let previousModel = self.applyOptimisticModelPatch(agentID: actorID, model: model)
            let (ok, err) = await teamclawService.setModelRpc(
                targetActorID: routeActor,
                runtimeID: runtimeID,
                modelID: model)
            if !ok {
                print("[RuntimeDetailVM] setModel RPC failed: \(err)")
                self.rollbackOptimisticModelPatch(agentID: actorID, previousModel: previousModel)
                return
            }
            // refreshMemberSheet re-reads Supabase, which the daemon writes
            // concurrently in a tokio::spawn. Apply the selection optimistically
            // AFTER the refresh so the Supabase race doesn't overwrite the choice.
            await self.refreshMemberSheet()
            if let idx = self.memberSheetAgents.firstIndex(where: { $0.id == actorID }),
               self.memberSheetAgents[idx].currentModel != model {
                let cur = self.memberSheetAgents[idx]
                self.memberSheetAgents[idx] = MemberSheetAgent(
                    id: cur.id, displayName: cur.displayName,
                    workspacePath: cur.workspacePath, agentType: cur.agentType,
                    runtimeState: cur.runtimeState, availableModels: cur.availableModels,
                    currentModel: model, runtimeID: cur.runtimeID,
                    workspaceID: cur.workspaceID, backendType: cur.backendType
                )
            }
        }
    }

    @discardableResult
    private func applyOptimisticModelPatch(agentID actorID: String, model: String) -> String? {
        guard let idx = memberSheetAgents.firstIndex(where: { $0.id == actorID }) else { return nil }
        let previous = memberSheetAgents[idx].currentModel
        let cur = memberSheetAgents[idx]
        memberSheetAgents[idx] = MemberSheetAgent(
            id: cur.id, displayName: cur.displayName,
            workspacePath: cur.workspacePath, agentType: cur.agentType,
            runtimeState: cur.runtimeState, availableModels: cur.availableModels,
            currentModel: model,
            runtimeID: cur.runtimeID, workspaceID: cur.workspaceID, backendType: cur.backendType
        )
        return previous
    }

    private func rollbackOptimisticModelPatch(agentID actorID: String, previousModel: String?) {
        guard let idx = memberSheetAgents.firstIndex(where: { $0.id == actorID }) else { return }
        let cur = memberSheetAgents[idx]
        memberSheetAgents[idx] = MemberSheetAgent(
            id: cur.id, displayName: cur.displayName,
            workspacePath: cur.workspacePath, agentType: cur.agentType,
            runtimeState: cur.runtimeState, availableModels: cur.availableModels,
            currentModel: previousModel,
            runtimeID: cur.runtimeID, workspaceID: cur.workspaceID, backendType: cur.backendType
        )
    }

    /// Removes an agent participant from this session.
    ///
    /// Three-step ordering:
    ///   1. Stop the agent's runtime (best-effort) so the Claude Code
    ///      subprocess actually exits — otherwise it keeps the worktree
    ///      busy and the session row in `agent_runtimes` stays "active"
    ///      until next daemon restart.
    ///   2. RPC the daemon to drop the agent from its in-memory session
    ///      participant cache + sessions.toml, and fan a notify event so
    ///      other connected clients re-pull. Best-effort; the Supabase
    ///      delete below is authoritative.
    ///   3. Delete the participant row from Supabase (source of truth).
    ///
    /// When the agent has no resolvable runtime id (e.g. the daemon is
    /// offline or `agent_runtimes` hasn't surfaced the row yet), step 1
    /// is skipped with a logged warning. The subprocess then keeps running
    /// until the daemon notices the participant is gone on next reload —
    /// suboptimal but recoverable.
    public func removeAgent(_ actorID: String) {
        Task { [weak self] in
            guard let self,
                  let sessionID = self.session?.sessionId,
                  !sessionID.isEmpty else { return }

            let routeActor = self.routeActorID(forAgentActorID: actorID)
            let runtimeID = self.runtimeID(forAgentActorID: actorID)

            // 1. Stop the agent's runtime (best-effort).
            if let routeActor, !routeActor.isEmpty,
               let runtimeID, !runtimeID.isEmpty,
               let teamclawService = self.teamclawService {
                let (ok, err) = await teamclawService.runtimeStopRpc(
                    targetActorID: routeActor, runtimeID: runtimeID)
                if !ok {
                    print("[RuntimeDetailVM] removeAgent: runtimeStop failed: \(err)")
                }
            } else {
                print("[RuntimeDetailVM] removeAgent: skipping runtimeStop — routeActor=\(routeActor ?? "nil") runtimeID=\(runtimeID ?? "nil")")
            }

            // 2. Best-effort daemon-side participant removal for cache
            //    invalidation + peer notify fanout.
            if let routeActor, !routeActor.isEmpty,
               let teamclawService = self.teamclawService {
                let (ok, err) = await teamclawService.removeParticipantRpc(
                    targetActorID: routeActor,
                    sessionID: sessionID,
                    actorID: actorID)
                if !ok {
                    print("[RuntimeDetailVM] removeAgent: removeParticipantRpc failed: \(err)")
                }
            }

            // 3. Supabase delete (source of truth).
            let sessionsRepo = self.sessionsRepository
            if let sessionsRepo {
                do {
                    try await sessionsRepo.removeParticipant(sessionID: sessionID, actorID: actorID)
                } catch {
                    print("[RuntimeDetailVM] removeAgent: removeParticipant failed: \(error)")
                }
            } else {
                print("[RuntimeDetailVM] removeAgent: no sessions repo available")
            }

            await self.refreshMemberSheet()
        }
    }

    /// Resolves the routing actor id of the daemon backing an agent actor,
    /// using the in-memory `ConnectedAgentsStore`. Returns nil when the store
    /// hasn't loaded the agent yet (caller should treat as "skip / log").
    /// Same lookup `addAgent` and `NewSessionSheet` use to route runtime RPCs.
    private func routeActorID(forAgentActorID actorID: String) -> String? {
        connectedAgentsStore?.agents.first(where: { $0.id == actorID })?.id
    }

    /// Looks up the daemon's 8-char runtime id for an agent actor in the
    /// current session, reading from the `MemberSheetAgent` snapshot that
    /// `refreshMemberSheet` populated. Nil when the row hasn't been seen yet
    /// (just-spawned, daemon offline, or not-yet-bound to this session).
    private func runtimeID(forAgentActorID actorID: String) -> String? {
        memberSheetAgents.first(where: { $0.id == actorID })?.runtimeID
    }

    // MARK: - Index caches (for O(1) event lookup during streaming)
    //
    // Long sessions accumulate thousands of events. Each tool_result /
    // permission_resolved / tool_title_update previously did a
    // `lastIndex(where:)` scan, making the event-handling hot path O(n)
    // and the full session O(n²). These maps + optionals give O(1) lookup;
    // they're maintained incrementally by `appendEvent`/`removeEvent` and
    // rebuilt after bulk operations (fetch, sort, insert-at-zero).
    private var toolUseIndexByToolId: [String: Int] = [:]
    private var permissionIndexByRequestId: [String: Int] = [:]
    private var planUpdateIndexByAgent: [String: Int] = [:]

    private func rebuildIndexes() {
        toolUseIndexByToolId.removeAll(keepingCapacity: true)
        permissionIndexByRequestId.removeAll(keepingCapacity: true)
        planUpdateIndexByAgent.removeAll(keepingCapacity: true)
        for (i, e) in events.enumerated() { registerIndex(event: e, at: i) }
    }

    private func registerIndex(event: AgentEvent, at idx: Int) {
        switch event.eventType {
        case "tool_use":
            if let id = event.toolId { toolUseIndexByToolId[id] = idx }
        case "permission_request":
            if let id = event.toolId { permissionIndexByRequestId[id] = idx }
        case "plan_update":
            planUpdateIndexByAgent[event.agentId] = idx
        default:
            break
        }
    }

    private func appendEvent(_ event: AgentEvent) {
        let idx = events.count
        events.append(event)
        registerIndex(event: event, at: idx)
    }

    private func removeEvent(at idx: Int) {
        let removed = events.remove(at: idx)
        switch removed.eventType {
        case "tool_use":
            if let id = removed.toolId, toolUseIndexByToolId[id] == idx {
                toolUseIndexByToolId.removeValue(forKey: id)
            }
        case "permission_request":
            if let id = removed.toolId, permissionIndexByRequestId[id] == idx {
                permissionIndexByRequestId.removeValue(forKey: id)
            }
        case "plan_update":
            if planUpdateIndexByAgent[removed.agentId] == idx {
                planUpdateIndexByAgent.removeValue(forKey: removed.agentId)
            }
        default: break
        }
        // Shift indexes that pointed past the removed position. k is tiny
        // in practice (one output, one todo, a handful of permissions,
        // tool count per session), so this stays well below the old
        // lastIndex(where:) cost over the whole event stream.
        for (k, v) in toolUseIndexByToolId where v > idx {
            toolUseIndexByToolId[k] = v - 1
        }
        for (k, v) in permissionIndexByRequestId where v > idx {
            permissionIndexByRequestId[k] = v - 1
        }
        for (agent, v) in planUpdateIndexByAgent where v > idx {
            planUpdateIndexByAgent[agent] = v - 1
        }
    }

    /// Validated O(1) lookup. Returns nil (and clears the stale cache
    /// entry) if the cached index no longer matches the predicate, so
    /// callers fall through to their "create new" branch as before.
    private func toolUseIndex(forToolId id: String) -> Int? {
        if let idx = toolUseIndexByToolId[id],
           idx < events.count,
           events[idx].eventType == "tool_use",
           events[idx].toolId == id {
            return idx
        }
        toolUseIndexByToolId.removeValue(forKey: id)
        return nil
    }

    private func permissionIndex(forRequestId id: String) -> Int? {
        if let idx = permissionIndexByRequestId[id],
           idx < events.count,
           events[idx].eventType == "permission_request",
           events[idx].toolId == id {
            return idx
        }
        permissionIndexByRequestId.removeValue(forKey: id)
        return nil
    }

    /// Find an in-flight (incomplete) `output` event belonging to a
    /// specific agent. Used by per-agent streaming output flow so two
    /// concurrent agents don't accidentally claim each other's pending
    /// row when finalizing or replacing a synthetic stop()-saved event.
    private func incompleteOutputIndex(forAgentID agentID: String) -> Int? {
        // Walk newest-first since incomplete outputs cluster near the end.
        var i = events.count - 1
        while i >= 0 {
            let e = events[i]
            if e.eventType == "output",
               e.isComplete == false,
               (e.senderActorID ?? "") == agentID {
                return i
            }
            i -= 1
        }
        return nil
    }

    public func start(modelContext: ModelContext) {
        // Idempotent on re-appear. SwiftUI's NavigationStack fires the
        // source view's `.onAppear` again when a pushed destination
        // pops back; the VM and its MQTT subscription are still alive
        // from the first start(). Cancelling and re-running setup
        // would drop the in-flight `for await msg in stream` loop
        // mid-iteration, so every ACP envelope that arrived while the
        // destination was on top is lost. (Bug visible as
        // StreamingDetailView freezing on the first thinking row
        // until you navigate back, at which point the missed events
        // replay in via incremental sync.)
        if task != nil { return }
        startModelContext = modelContext

        // Bind session persistence for chip-bar selection (idempotent —
        // bind() is a no-op after the first start() returns since `task`
        // guards re-entry above).
        if let s = session {
            bind(session: s, modelContext: modelContext)
        }

        // resolveRuntime may return a placeholder for session-with-pending-
        // primary-agent or nil for collab-only sessions with no agent yet.
        // Either is fine — the cached event load + Supabase seed work off
        // session.sessionId scope, and the streaming subscribe block below
        // gates on `session` not on `runtime`.
        let runtime = resolveRuntime(modelContext: modelContext)

        if let runtime {
            // Clear unread badge when user opens the session
            runtime.hasUnread = false
            try? modelContext.save()

            // Seed slash commands from the cached state-topic snapshot so
            // the composer popup is populated before (or even without) a
            // fresh AvailableCommandsUpdate arriving on the events stream.
            let cachedCommands = runtime.availableCommands
            if !cachedCommands.isEmpty && dynamicAvailableCommands.isEmpty {
                dynamicAvailableCommands = cachedCommands
            }
        }

        // Inbox red-dot clear: local first for instant UI, then the
        // server upsert so other devices' next fetchUnreadFlags() reflects
        // the read. Building the repo on demand avoids plumbing it through
        // every SessionDetailView call site; the SupabaseClient is cheap.
        if let session, session.hasUnread {
            session.hasUnread = false
            try? modelContext.save()
        }
        if let sessionId = session?.sessionId {
            Task.detached {
                guard let config = CloudAPIConfigurationStore.configuration() else { return }
                let storage = KeychainSessionStorage()
                let repo = CloudAPIRepositoryFactory.sessionsRepository(configuration: config) {
                    guard let s = try storage.load(), s.expiresAt.timeIntervalSinceNow > 0 else {
                        throw CloudAPIError.missingAccessToken
                    }
                    return s.accessToken
                }
                try? await repo.markSessionViewed(sessionId: sessionId, lastReadMessageId: nil)
            }
        }

        // Load cached events immediately (works offline). Scope keys on
        // session_id when present so collab-only sessions (no runtime yet)
        // still see past Supabase-seeded messages.
        let scope = eventScopeKey
        let descriptor = FetchDescriptor<AgentEvent>(
            predicate: #Predicate { $0.agentId == scope },
            sortBy: [SortDescriptor(\.timestamp), SortDescriptor(\.sequence)]
        )
        events = (try? modelContext.fetch(descriptor)) ?? []
        pruneDuplicateRuntimeEvents(modelContext: modelContext)
        sortEventsForDisplay()
        // Rehydrate the reducer's state from persisted events so
        // future applies dedup against prior session history.
        rehydrateTimelineStateFromEvents()

        // Insert initial prompt as first user bubble if not already present
        let initialPrompt: String = {
            if let session, !session.summary.isEmpty { return session.summary }
            if let runtime, !runtime.currentPrompt.isEmpty { return runtime.currentPrompt }
            return ""
        }()

        if !initialPrompt.isEmpty && !events.contains(where: { $0.eventType == "user_prompt" }) {
            let promptEvent = AgentEvent(agentId: scope, sequence: 0, eventType: "user_prompt")
            promptEvent.text = initialPrompt
            // Initial prompt comes from session.summary or runtime.currentPrompt
            // — both written by the session creator at create-time. Stamp the
            // creator so the chat row reads as theirs even before any live
            // messages arrive.
            promptEvent.senderActorID = session?.createdBy
            modelContext.insert(promptEvent)
            events.insert(promptEvent, at: 0)
            // insert-at-zero shifts every cached index; cheaper to rebuild
            rebuildIndexes()
            rehydrateTimelineStateFromEvents()
        }

        recomputeGroups()
        hasLoadedInitialFeed = true
        // Resume streaming state from any stop()-saved incomplete output
        // rows — one per agent that was mid-stream. Handles every agent
        // (multi-agent sessions persist one synthetic row each) and drops
        // the synthetic rows once their bytes are back in the buffers.
        restoreStreamingAgentSetFromIncompleteOutput()

        // Single subscription path: session/{sid}/live. iOS only ever
        // resolves a session-backed detail view — bare-runtime navigation
        // was deleted alongside RuntimeDestinationView. Daemon mirrors this
        // by fanning all agent envelopes (ACP events + HistoryBatch
        // replies) onto the same topic.
        guard let session else {
            print("[RuntimeDetailVM] no session bound; skipping subscribe")
            return
        }
        let subscribeTopic = MQTTTopics.sessionLive(teamID: teamID, sessionID: session.sessionId)
        let mqtt = self.mqtt
        let hub = self.hub
        task = Task { @MainActor [weak self, mqtt, hub, subscribeTopic, modelContext] in
            // Outer loop: each iteration represents a fresh MQTT connection lifecycle.
            // When the inner stream finishes (e.g. after disconnect clears continuations),
            // we loop back, wait for reconnect, resubscribe, and trigger an incremental
            // sync to fetch any events missed during the gap.
            while !Task.isCancelled {
                // Wait for MQTT to be connected
                while mqtt.connectionState != .connected {
                    try? await Task.sleep(for: .milliseconds(200))
                    if Task.isCancelled { return }
                }

                // Hub-filtered stream: only messages on the bound session's
                // live topic. The subscribe call below tells the broker to
                // deliver them; the predicate is the belt to those suspenders.
                let stream = await hub.messages(topic: subscribeTopic)
                try? await mqtt.subscribe(subscribeTopic)
                print("[RuntimeDetailVM] subscribed to \(subscribeTopic)")

                // Two-source recovery:
                //   1. Supabase `messages` for past finalized turns —
                //      this is the team-wide truth that survives any
                //      single daemon's history buffer (multi-agent
                //      friendly).
                //   2. Daemon RequestHistory for events the broker may
                //      have dropped on the floor (new session that's
                //      streaming RIGHT NOW between Supabase persistence
                //      and our subscribe; or kill+relaunch mid-turn).
                //      Without this, fresh session detail shows nothing
                //      until the agent finishes a turn.
                // Dedupe: Supabase-seeded events carry a supabaseMessageId
                // and won't be duplicated by re-running the seed; daemon
                // replay uses sequence-based filtering. Some past-turn
                // double-display can happen for sessions that have BOTH
                // Supabase rows AND daemon history; acceptable trade-off
                // until we add cross-source content dedupe.
                await self?.seedFromSupabaseMessages(modelContext: modelContext)
                // Replay daemon-recorded envelopes for any agent the
                // local state still thinks is mid-stream. Catches the
                // case where the broker dropped the trailing
                // `status_change=idle` (or other late envelopes) while
                // we were disconnected — without this the active-stream
                // card hangs until the user pulls-to-refresh.
                await self?.replayStreamingTurnsAfterReconnect(modelContext: modelContext)
                // No cold-start full-sync — Supabase rows are the timeline
                // source of truth for completed turns. Intermediate ACP
                // events (thinking / tool calls / partial outputs) live in
                // the daemon's per-runtime EventHistory and are fetched
                // on-demand by `requestTurnHistory` when the user opens a
                // turn-detail view.

                for await msg in stream {
                    guard let self else { return }
                    guard let live = try? Teamclaw_LiveEventEnvelope(serializedBytes: msg.payload)
                    else { continue }

                    if live.eventType == "acp.event",
                       let envelope = try? Amux_Envelope(serializedBytes: live.body) {
                        handleEnvelope(envelope, modelContext: modelContext)
                    } else if live.eventType.hasPrefix("message."),
                              let msgEnv = try? Teamclaw_SessionMessageEnvelope(serializedBytes: live.body),
                              msgEnv.hasMessage {
                        // Other collaborators' chat messages — convert to a
                        // user_prompt AgentEvent so EventFeedView renders
                        // them. Loopback / dedupe handled inside.
                        handleIncomingChatMessage(msgEnv.message, modelContext: modelContext)
                    }
                }
                // Stream finished — connection likely dropped. Loop and resubscribe.
                if Task.isCancelled { return }
                print("[RuntimeDetailVM] stream ended, waiting to resubscribe…")
            }
        }
    }

    /// VM lifetime cleanup. Task closure captures `self` weakly so this
    /// fires once the owning view drops its last reference (e.g., user
    /// navigates back from the session detail to the session list).
    /// Without explicit cancel here, the `while !Task.isCancelled` loop
    /// keeps spinning and the MQTT subscription leaks.
    deinit {
        task?.cancel()
        spawningPollTask?.cancel()
    }

    public func stop() {
        task?.cancel(); task = nil
        spawningPollTask?.cancel(); spawningPollTask = nil
        streamingMirrorFlushTask?.cancel(); streamingMirrorFlushTask = nil
        for (_, t) in interruptTimeoutTasks { t.cancel() }
        interruptTimeoutTasks = [:]
        interruptPendingAgents = []
        // Unsubscribe from extra runtime-state topics added for session agents
        // that aren't in ConnectedAgentsStore. SessionListViewModel manages its
        // own set; we only clean up the ones we added here.
        if !sessionAgentSubscribedActorIDs.isEmpty {
            let toUnsub = sessionAgentSubscribedActorIDs
            let mqtt = self.mqtt
            let teamID = self.teamID
            Task {
                for actorID in toUnsub {
                    let topic = MQTTTopics.runtimeStateWildcard(teamID: teamID, actorID: actorID)
                    try? await mqtt.unsubscribe(topic)
                }
            }
            sessionAgentSubscribedActorIDs.removeAll()
        }

        // Flush every in-progress per-agent streaming buffer to a
        // persisted incomplete event so it's visible when the user returns.
        // Multi-agent: each active stream gets its own synthetic row stamped
        // with the producing agent's actor id.
        // The @Observable mirror lags the reducer by up to one throttle
        // interval — sync it first so the persisted partial carries the
        // full streamed text.
        mirrorReducerStreamingState()
        if !streamingAgentSet.isEmpty, runtime != nil, let ctx = startModelContext {
            var seq = (events.last?.sequence ?? 0) + 1
            for agentID in streamingAgentSet {
                guard let text = streamingTextByAgent[agentID], !text.isEmpty else { continue }
                let event = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "output")
                event.senderActorID = agentID
                event.text = text
                event.isComplete = false
                event.model = streamingModelByAgent[agentID]
                event.turnID = streamingTurnIDByAgent[agentID]
                ctx.insert(event)
                appendEvent(event)
                seq += 1
            }
            try? ctx.save()
            streamingAgentSet.removeAll()
            streamingTextByAgent.removeAll()
            streamingModelByAgent.removeAll()
            streamingTurnIDByAgent.removeAll()
            recomputeGroups()
        }
        startModelContext = nil
    }

    /// Persistent ids of the snapshot rows written by the most recent
    /// `flushStreamingForBackground()`. Per-agent so the foreground
    /// counterpart can find them without colliding with any other
    /// incomplete-output rows the daemon or `stop()` may have produced.
    private var backgroundSnapshotIDByAgent: [String: String] = [:]

    /// Persist a copy of every in-flight per-agent streaming buffer as
    /// an incomplete `output` row, without cancelling the MQTT task or
    /// mutating the in-memory streaming state. Wire to
    /// `scenePhase == .background`: if iOS reclaims the suspended
    /// process, the next cold launch's `start()` →
    /// `restoreStreamingAgentSetFromIncompleteOutput()` hydrate path picks
    /// the snapshot up and the user sees their partial text instead of an
    /// empty bubble.
    /// `discardBackgroundSnapshot()` removes it again on the common
    /// path where the process survived.
    public func flushStreamingForBackground() {
        // Sync the throttled mirror so the snapshot carries the full
        // streamed text, not a buffer up to one flush interval stale.
        mirrorReducerStreamingState()
        guard !streamingAgentSet.isEmpty,
              runtime != nil,
              let ctx = startModelContext else { return }

        // Drop any prior snapshot first so repeat bg/fg cycles don't
        // accumulate a chain of stale partials.
        discardBackgroundSnapshot()

        var seq = (events.last?.sequence ?? 0) + 1
        for agentID in streamingAgentSet {
            guard let text = streamingTextByAgent[agentID], !text.isEmpty else { continue }
            let event = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "output")
            event.senderActorID = agentID
            event.text = text
            event.isComplete = false
            event.model = streamingModelByAgent[agentID]
            event.turnID = streamingTurnIDByAgent[agentID]
            ctx.insert(event)
            // Deliberately NOT appendEvent — keep this row out of
            // `events` so the live UI keeps rendering the single
            // streaming buffer. The row exists only to survive a
            // suspended-process kill.
            backgroundSnapshotIDByAgent[agentID] = event.id
            seq += 1
        }
        try? ctx.save()
    }

    /// Counterpart to `flushStreamingForBackground()`. Deletes the
    /// snapshot rows we wrote on the way out now that the process
    /// has survived and the live `streamingTextByAgent` buffer is
    /// once again the source of truth. Idempotent.
    public func discardBackgroundSnapshot() {
        guard !backgroundSnapshotIDByAgent.isEmpty else { return }
        guard let ctx = startModelContext else {
            backgroundSnapshotIDByAgent.removeAll()
            return
        }
        for id in backgroundSnapshotIDByAgent.values {
            let descriptor = FetchDescriptor<AgentEvent>(
                predicate: #Predicate { $0.id == id }
            )
            if let row = (try? ctx.fetch(descriptor))?.first {
                ctx.delete(row)
            }
        }
        try? ctx.save()
        backgroundSnapshotIDByAgent.removeAll()
    }

    private func handleEnvelope(_ env: Amux_Envelope, modelContext: ModelContext) {
        switch env.payload {
        case .acpEvent(let acp):
            if handleAcpEvent(acp,
                              sequence: Int(env.sequence),
                              runtimeID: env.runtimeID,
                              turnID: env.turnID.isEmpty ? nil : env.turnID,
                              modelContext: modelContext) {
                try? modelContext.save()
                recomputeGroups()
            }
        case .sessionEvent(let evt): handleSessionEvent(evt, sequence: Int(env.sequence), modelContext: modelContext)
        case .none: break
        }
    }

    /// Handles a `message.created` live envelope (chat message from another
    /// collaborator, or a loopback of our own send). For pure-human sessions
    /// this is the only inbound source — there's no daemon fanning ACP
    /// events. We convert the proto message into a `user_prompt` AgentEvent
    /// so EventFeedView renders it the same way as the local user's typed
    /// prompts.
    ///
    /// Loopback dedupe is two-layer: senderActorID match against the local
    /// human actor catches the common case; a content+type fallback covers
    /// older actors that haven't resolved currentHumanActorId yet, and
    /// re-arrivals during reconnect.
    private func handleIncomingChatMessage(_ message: Teamclaw_Message, modelContext: ModelContext) {
        // Pre-filters: only render text messages, and drop our own
        // loopbacks + content-equal duplicates before feeding the
        // reducer so its identity-dedup doesn't conflate a fresh
        // message with a re-arrival under a different messageID.
        guard message.kind == .text else { return }
        let myActorID = teamclawService?.currentHumanActorId ?? ""
        if !myActorID.isEmpty, message.senderActorID == myActorID { return }
        let content = message.content
        if events.contains(where: {
            $0.eventType == "user_prompt" && ($0.text ?? "") == content
        }) {
            return
        }

        let dirty = applyTimelineInput(
            .liveMessage(LiveMessageInput(
                messageID: message.messageID.isEmpty ? UUID().uuidString : message.messageID,
                clientLocalID: nil,
                senderActorID: message.senderActorID,
                content: content,
                createdAt: message.createdAt > 0
                    ? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                    : .now
            )),
            modelContext: modelContext
        )
        if dirty { recomputeGroups() }
    }

    /// Builds a fresh AgentEvent stamped with the agent that produced it.
    /// Resolution prefers the agent actor id mapped from the envelope's
    /// `runtime_id` via `memberSheetAgents`; when that mapping isn't ready
    /// yet (cold start before refreshMemberSheet, or a runtime row not
    /// in the session participants) we stamp the runtime id itself so
    /// the event still lands in its own per-runtime bucket. We
    /// deliberately do NOT fall back to `session.primaryAgentId` —
    /// concurrent agents would otherwise cross-attribute their early
    /// events to whichever agent happens to be "primary."
    private func makeAgentSideEvent(sequence: Int,
                                    eventType: String,
                                    runtimeID: String? = nil) -> AgentEvent {
        let event = AgentEvent(agentId: eventScopeKey, sequence: sequence, eventType: eventType)
        event.senderActorID = bucketKey(forRuntimeID: runtimeID)
        return event
    }

    /// Resolve a daemon-side `runtime_id` (8-char) to the owning agent
    /// actor id by walking `memberSheetAgents`. Returns nil when no match
    /// — callers should fall back to the runtime id via `bucketKey`
    /// rather than to a session-wide "primary" agent.
    private func agentActorID(forRuntimeID runtimeID: String?) -> String? {
        guard let runtimeID, !runtimeID.isEmpty else { return nil }
        return memberSheetAgents.first(where: { $0.runtimeID == runtimeID })?.id
    }

    /// First-resolved bucket key per runtime_id, frozen for the lifetime
    /// of this VM. The mapping memberSheetAgents → bucketKey can flip
    /// from raw runtime_id to agent_actor_id mid-turn (memberSheet is
    /// loaded asynchronously). If thinking lands with the raw form and
    /// the closing output lands with the mapped form, the two entries
    /// pick up different `senderActorID`s and `buildFeedItems` strands
    /// the thinking row in a trailing activeStream card instead of
    /// bundling it into the completedTurn. Freezing on first resolve
    /// trades a momentary "raw id as chip label" cosmetic miss for a
    /// stable grouping key. New VM per detail view → cache rebuilds
    /// from scratch on every session open.
    private var resolvedBucketKeyByRuntimeID: [String: String] = [:]

    /// Stable per-agent bucket key used for `senderActorID` stamping and
    /// the streaming-buffer dictionaries. Returns the cached resolution
    /// if we've seen this runtime_id before; otherwise resolves once
    /// (mapped → fall back to raw runtime_id) and caches. Nil only when
    /// no runtime_id is supplied at all (legacy session-event paths).
    private func bucketKey(forRuntimeID runtimeID: String?) -> String? {
        guard let rid = runtimeID, !rid.isEmpty else { return nil }
        if let cached = resolvedBucketKeyByRuntimeID[rid] { return cached }
        let resolved = agentActorID(forRuntimeID: rid) ?? rid
        resolvedBucketKeyByRuntimeID[rid] = resolved
        return resolved
    }

    /// Once `memberSheetAgents` finishes loading, walk every state slice
    /// that stamps `senderActorID` and rewrite raw runtime_id stamps to
    /// the resolved agent_actor_id. Without this:
    ///   - live MQTT events that arrived before memberSheet loaded sit in
    ///     a "5ffcd7fc" (raw) bucket forever (`bucketKey` cache freezes
    ///     on first resolve to avoid mid-turn flips)
    ///   - Supabase-seeded history rows land in a "c6205a14-…" (actor id)
    ///     bucket for the same agent
    ///   - `buildFeedItems` strands them into separate `.completedTurn`
    ///     entries + leaves a permanent trailing `.activeStream` card
    ///     because `statusChange:.idle` resolves to the actor_id bucket
    ///     and doesn't match the streaming buffer's raw-id key
    private func relabelRawRuntimeIDStampsToActorIDs() {
        // runtime_id → actor_id from the freshly-loaded memberSheet.
        var mapping: [String: String] = [:]
        for agent in memberSheetAgents {
            guard let rid = agent.runtimeID, !rid.isEmpty, rid != agent.id else { continue }
            mapping[rid] = agent.id
        }
        if mapping.isEmpty { return }

        var didMutateEvents = false
        for (rawID, actorID) in mapping {
            // Refresh the resolution cache so future `bucketKey` calls
            // route to the actor id, not the raw runtime id.
            resolvedBucketKeyByRuntimeID[rawID] = actorID

            for idx in events.indices where events[idx].senderActorID == rawID {
                events[idx].senderActorID = actorID
                didMutateEvents = true
            }

            for idx in timelineState.entries.indices
                where timelineState.entries[idx].senderActorID == rawID {
                timelineState.entries[idx].senderActorID = actorID
            }

            // streamingAgentSet / streamingTextByAgent / streamingModelByAgent
            // are mirrored from timelineState by `applyTimelineInput` —
            // rewrite timelineState first, then mirror at the end.
            if timelineState.streamingAgentSet.remove(rawID) != nil {
                timelineState.streamingAgentSet.insert(actorID)
            }
            if let text = timelineState.streamingTextByAgent.removeValue(forKey: rawID) {
                timelineState.streamingTextByAgent[actorID, default: ""] += text
            }
            if let model = timelineState.streamingModelByAgent.removeValue(forKey: rawID) {
                timelineState.streamingModelByAgent[actorID] = model
            }
            if let turnID = timelineState.streamingTurnIDByAgent.removeValue(forKey: rawID) {
                timelineState.streamingTurnIDByAgent[actorID] = turnID
            }
            // Parked reconnect replays follow their bucket through the
            // relabel, so retryPendingTurnReplays() resolves against the
            // post-relabel key the streaming dictionaries now use.
            if pendingTurnReplayBuckets.remove(rawID) != nil {
                pendingTurnReplayBuckets.insert(actorID)
            }
        }

        // Mirror reducer state onto the VM's @Observable fields so the
        // chat feed picks up the rebucketed streaming buffers.
        streamingAgentSet = timelineState.streamingAgentSet
        streamingTextByAgent = timelineState.streamingTextByAgent
        streamingModelByAgent = timelineState.streamingModelByAgent
        streamingTurnIDByAgent = timelineState.streamingTurnIDByAgent

        if didMutateEvents {
            try? startModelContext?.save()
            recomputeGroups()
        } else {
            // Even if no SwiftData rows changed, streaming/state buckets
            // may have moved; recompute so the trailing activeStream card
            // (if any) re-renders against the new bucket.
            recomputeGroups()
        }
    }

    /// Applies one ACP event to in-memory + SwiftData state. Returns `true`
    /// iff the event caused a SwiftData mutation or a change to grouping-
    /// relevant fields; callers save + recompute groups only when `true`.
    /// Streaming deltas (the hot path, dozens per second) return `false`
    /// after the first delta of a stream, skipping the SQLite commit and
    /// the O(n) regroup that would otherwise fire on every token.
    @discardableResult
    private func handleAcpEvent(_ acp: Amux_AcpEvent,
                                sequence: Int,
                                runtimeID: String? = nil,
                                turnID: String? = nil,
                                isHistoryReplay: Bool = false,
                                modelContext: ModelContext) -> Bool {
        // Heartbeat: any live ACP event arrival means the runtime is busy.
        // Skip for history-replay batches (requestTurnHistory responses) —
        // those events belong to an already-completed turn and must not
        // flip the agent chip to "running".
        // Also skip for statusChange: a runtime transitioning to "active"
        // (daemon spawn ready) does not mean the agent is processing a user
        // prompt. Only thinking / tool_use / output events indicate real work.
        if !isHistoryReplay, case .statusChange(_) = acp.event {
            // lifecycle event — don't mark working
        } else if !isHistoryReplay {
            markAgentWorking()
        }

        // Reducer is source of truth for entry mutations. Apply +
        // project. Side effects the reducer doesn't track (runtime
        // status flip, heartbeat reset) are handled below.
        let bucket = bucketKey(forRuntimeID: runtimeID) ?? eventScopeKey
        let dirty = applyTimelineInput(
            .acp(AcpInput(
                envelopeSequence: UInt64(sequence),
                runtimeID: runtimeID ?? "",
                agentBucketKey: bucket,
                timestamp: .now,
                turnID: turnID,
                acpEvent: acp
            )),
            modelContext: modelContext
        )

        // Runtime status + heartbeat side effects. Idle settles ONLY this
        // bucket — the reducer just flushed its partial text and cleared
        // its streaming slots; concurrent agents' live buffers stay
        // untouched (the old global markAgentDone() wiped them, losing
        // their streamed text mid-turn).
        if case .statusChange(let sc) = acp.event {
            runtime?.status = Int(sc.newStatus.rawValue)
            if sc.newStatus == .idle { settleAgentTurn(bucket: bucket) }
        }

        // Hand-rolled raw tool_title_update parser. The reducer
        // explicitly leaves `.raw` alone (see TimelineInput.swift
        // contract); patch the matching tool_use entry in place.
        if case .raw(let raw) = acp.event, raw.method == "tool_title_update" {
            let payload = String(data: raw.jsonPayload, encoding: .utf8) ?? ""
            if let pipeIdx = payload.firstIndex(of: "|") {
                let toolId = String(payload[payload.startIndex..<pipeIdx])
                let newTitle = String(payload[payload.index(after: pipeIdx)...])
                if let idx = events.firstIndex(where: { $0.eventType == "tool_use" && $0.toolId == toolId }) {
                    events[idx].toolName = newTitle
                    try? modelContext.save()
                    return true
                }
            }
        }

        return dirty
    }

    private func handleSessionEvent(_ sessionEvent: Amux_SessionEvent, sequence: Int, modelContext: ModelContext) {
        switch sessionEvent.event {
        case .promptAccepted:
            // Confirmation: set runtime to active (triggers typing indicator)
            runtime?.status = Int(Amux_AgentStatus.active.rawValue)
        case .promptRejected(let pr):
            let event = makeAgentSideEvent(sequence: sequence, eventType: "error")
            event.text = "Rejected: \(pr.reason)"
            appendEvent(event)
            recomputeGroups()
        case .permissionResolved(let resolved):
            // Reducer updates the matching permission_request entry
            // in place; sync mirrors the mutation onto the SwiftData
            // row. Drops silently if there's no matching entry, same
            // as the prior inline behaviour.
            let dirty = applyTimelineInput(
                .permissionResolution(PermissionResolutionInput(
                    requestID: resolved.requestID,
                    granted: resolved.granted
                )),
                modelContext: modelContext
            )
            if dirty { recomputeGroups() }
        case .historyBatch(let batch):
            handleHistoryBatch(batch)
        case .none:
            break
        }
    }

    private var syncModelContext: ModelContext?
    public var isSyncing = false
    private var syncGeneration: Int = 0
    private var startModelContext: ModelContext?

    private func handleHistoryBatch(_ batch: Amux_HistoryBatch) {
        guard let modelContext = syncModelContext else { return }
        let existingSeqs = Set(events.compactMap { $0.sequence != 0 ? $0.sequence : nil })

        // Aggregate dirty across the batch so we save + regroup once per page
        // instead of per-event. Sort+regroup is deferred to the last page in
        // the common case where the client keeps paginating (batch.hasMore_p).
        var anyDirty = false
        for envelope in batch.events {
            let seq = Int(envelope.sequence)
            guard !existingSeqs.contains(seq) else { continue }

            if case .acpEvent(let acp) = envelope.payload {
                if handleAcpEvent(acp,
                                  sequence: seq,
                                  runtimeID: envelope.runtimeID,
                                  turnID: envelope.turnID.isEmpty ? nil : envelope.turnID,
                                  isHistoryReplay: true,
                                  modelContext: modelContext) {
                    anyDirty = true
                }
            }
        }

        if anyDirty {
            try? modelContext.save()
        }

        // Turn-history responses arrive as a single batch — the daemon
        // sets has_more=true only when the trim-to-budget loop dropped
        // events. We don't paginate (no cursor for turn-scope queries)
        // so the local streaming cache + live MQTT deltas fill the gap
        // for huge turns. Always finalize after one batch.
        sortEventsForDisplay()
        recomputeGroups()
        syncGeneration &+= 1
        isSyncing = false
    }

    /// Fetch events newer than our local max sequence from the daemon.
    /// Cursor-based + paginated — cheap to call on every reconnect / foreground.
    ///
    /// Pull `messages` rows for this session from Supabase and project them
    /// into AgentEvent rows so past completed turns are visible without
    /// hitting the daemon's per-runtime history buffer. Dedupe is keyed on
    /// `supabaseMessageId` — re-running the seed is a no-op once the rows
    /// have been ingested. Tool calls / thinking / status events are NOT
    /// represented; only `user_*` and `agent_reply` kinds become AgentEvents.
    public func seedFromSupabaseMessages(modelContext: ModelContext) async {
        guard let session else { return }
        guard let repo = messagesRepository else { return }
        let messages: [MessageRecord]
        do {
            messages = try await repo.listForSession(sessionID: session.sessionId)
        } catch {
            print("[RuntimeDetailVM] supabase messages seed failed: \(error)")
            return
        }
        guard !messages.isEmpty else { return }

        // Reducer dedupes by `supabaseMessageID` and backfills the
        // id onto an existing content-equal entry when one exists.
        // Apply per record, project once at the end.
        var anyChange = false
        for record in messages {
            let kind: HistoryKind
            switch record.kind {
            case "agent_reply": kind = .output
            // "text" is the legacy iOS write spelling — kept here so
            // rows that landed in Supabase before the writer switched
            // to "user_message" still rehydrate. Drop once those rows
            // age out.
            case "user_message", "user_prompt", "text": kind = .userPrompt
            default: continue
            }
            let dirty = applyTimelineInput(
                .historyMessage(HistoryInput(
                    supabaseMessageID: record.id,
                    kind: kind,
                    senderActorID: record.senderActorID.isEmpty ? nil : record.senderActorID,
                    content: record.content,
                    createdAt: record.createdAt,
                    model: record.model,
                    turnID: record.turnID,
                    sequence: record.sequence
                )),
                modelContext: modelContext
            )
            if dirty { anyChange = true }
        }
        if anyChange { recomputeGroups() }
    }

    /// On MQTT reconnect, replay the daemon's recorded envelopes for
    /// any agent whose stream the broker may have left mid-turn. The
    /// reducer's `.statusChange=idle` (and any thinking/tool envelopes
    /// the broker dropped) flow back through the same code path that
    /// originally clears `streamingAgentSet`, so the active-stream
    /// card converges to the post-turn state without waiting for a
    /// user pull-to-refresh. Idempotent: existing entries dedupe by
    /// turnID / sequence in `applyAcp`.
    private func replayStreamingTurnsAfterReconnect(modelContext: ModelContext) async {
        let snapshot = streamingTurnIDByAgent
        guard !snapshot.isEmpty else { return }
        for (bucket, turnID) in snapshot {
            guard !turnID.isEmpty else { continue }
            // `bucket` is the actor id post-resolve; the daemon's
            // RequestTurnHistory wants a runtime id. Map actor → runtime
            // via the member sheet. When the mapping isn't available yet,
            // do NOT send the bucket verbatim — the daemon answers an
            // unknown runtime id with nothing and the active-stream card
            // hangs forever. Park the bucket instead and retry once after
            // `refreshMemberSheet` lands the roster.
            guard let runtimeID = turnReplayRuntimeID(forBucket: bucket), !runtimeID.isEmpty else {
                pendingTurnReplayBuckets.insert(bucket)
                print("[RuntimeDetailVM] replay deferred for \(bucket)/\(turnID): runtime id not resolvable yet")
                continue
            }
            pendingTurnReplayBuckets.remove(bucket)
            do {
                try await self.requestTurnHistory(
                    modelContext: modelContext,
                    turnID: turnID,
                    agentID: runtimeID
                )
            } catch {
                print("[RuntimeDetailVM] replay turn history failed for \(bucket)/\(turnID): \(error)")
            }
        }
    }

    /// Buckets whose mid-stream turn replay couldn't be routed yet because
    /// the actor_id → runtime_id mapping wasn't loaded. Retried once after
    /// `refreshMemberSheet` completes (see `retryPendingTurnReplays`).
    private var pendingTurnReplayBuckets: Set<String> = []

    /// Resolve the daemon runtime id to use when replaying `bucket`'s
    /// in-flight turn. Returns nil to mean "defer — don't send anything":
    /// passing the bucket itself through is only valid in the
    /// pre-memberSheet window where buckets ARE raw runtime ids. Once the
    /// roster is loaded, an actor-id bucket without a bound runtime row
    /// must wait instead of being sent verbatim as a runtime id.
    private func turnReplayRuntimeID(forBucket bucket: String) -> String? {
        if let rid = runtimeID(forAgentActorID: bucket), !rid.isEmpty { return rid }
        // Roster not loaded yet — can't tell actor ids from raw runtime
        // ids; defer until refreshMemberSheet lands.
        if memberSheetAgents.isEmpty { return nil }
        // Known agent actor id whose runtime row isn't bound yet
        // (just-spawned / daemon offline) — defer rather than misroute.
        if memberSheetAgents.contains(where: { $0.id == bucket }) { return nil }
        // Roster is loaded and the bucket isn't an actor id in it: this is
        // a raw runtime-id stamp from the pre-memberSheet window. Sending
        // it as the runtime id is correct.
        return bucket
    }

    /// One-shot retry for replays parked by
    /// `replayStreamingTurnsAfterReconnect`. Runs after `refreshMemberSheet`
    /// lands the roster — post-relabel, so parked bucket keys have already
    /// been rewritten raw runtime id → actor id where applicable. Buckets
    /// that still don't resolve keep the prior state (no send) but log;
    /// each parked bucket gets exactly one retry so we never replay-loop.
    private func retryPendingTurnReplays() async {
        guard !pendingTurnReplayBuckets.isEmpty else { return }
        let parked = pendingTurnReplayBuckets
        pendingTurnReplayBuckets = []
        guard let ctx = startModelContext else { return }
        for bucket in parked {
            // The stream may have settled (idle / interrupt) while we
            // waited for the roster — nothing left to replay then.
            guard streamingAgentSet.contains(bucket),
                  let turnID = streamingTurnIDByAgent[bucket], !turnID.isEmpty else { continue }
            guard let runtimeID = turnReplayRuntimeID(forBucket: bucket), !runtimeID.isEmpty else {
                print("[RuntimeDetailVM] replay retry for \(bucket)/\(turnID) still unroutable; giving up")
                continue
            }
            do {
                try await requestTurnHistory(modelContext: ctx, turnID: turnID, agentID: runtimeID)
            } catch {
                print("[RuntimeDetailVM] replay retry failed for \(bucket)/\(turnID): \(error)")
            }
        }
    }

    /// Fetch every envelope the daemon has for a specific turn from a
    /// specific runtime's EventHistory log. Used by `StreamingDetailView`
    /// (turn-detail drill-down from the bubble's top-right entry) to show
    /// thinking / tool calls / partial outputs the session timeline
    /// intentionally omits. Repeat calls are cheap — daemon scans the
    /// runtime's index in memory and reducer dedupe handles overlap.
    ///
    /// `agentID` defaults to the current runtime; pass an explicit value
    /// when the turn was produced by a different runtime in the same
    /// session (multi-runtime fanouts).
    public func requestTurnHistory(modelContext: ModelContext,
                                   turnID: String,
                                   agentID: String? = nil) async throws {
        guard !turnID.isEmpty else { return }
        self.syncModelContext = modelContext
        isSyncing = true

        // Watchdog — if the daemon never replies, `isSyncing` must reset
        // so a follow-up tap can re-issue cleanly. Same generation-token
        // trick the old sequence-based sync used.
        syncGeneration &+= 1
        let myGeneration = syncGeneration
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self else { return }
            if self.syncGeneration == myGeneration && self.isSyncing {
                self.isSyncing = false
            }
        }

        // The bubble passes an actor id (route.agentID). Resolve it to
        // the owning runtime + route actor id via the same helper sendCommand
        // uses so the MQTT topic matches the daemon's subscription.
        let route = commandRoute(forAgentActorID: agentID, fallbackRuntime: runtime)
        guard !route.runtimeID.isEmpty else { return }

        var req = Amux_AcpRequestTurnHistory()
        req.turnID = turnID
        req.requestID = UUID().uuidString

        let sender = RuntimeCommandSender(mqtt: mqtt, teamID: teamID, peerID: peerId)
        try await sender.send(
            runtimeID: route.runtimeID,
            actorID: route.actorID,
            currentHumanActorID: teamclawService?.currentHumanActorId,
            makeCommand: { $0.command = .requestTurnHistory(req) }
        )
    }

    private func sendCommand(agentActorID: String? = nil,
                             makeCommand: sending (inout Amux_AcpCommand) -> Void) async throws {
        let route = commandRoute(forAgentActorID: agentActorID, fallbackRuntime: runtime)
        guard !route.runtimeID.isEmpty else {
            let key = agentActorID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let error: SendCommandError = key.isEmpty ? .noRuntime : .runtimeIdEmpty
            await surfaceSendError(error)
            throw error
        }
        let sender = RuntimeCommandSender(mqtt: mqtt, teamID: teamID, peerID: peerId)
        do {
            try await sender.send(
                runtimeID: route.runtimeID,
                actorID: route.actorID,
                currentHumanActorID: teamclawService?.currentHumanActorId,
                makeCommand: makeCommand
            )
        } catch let error as SendCommandError {
            if case .routeActorIdUnresolved = error {
                print("[RuntimeDetailVM] dropping command — route actor id not resolved (primaryAgentId=\(session?.primaryAgentId ?? "nil") runtimeId=\(route.runtimeID) agentActorID=\(agentActorID ?? "nil"))")
            }
            surfaceSendError(error)
            throw error
        } catch {
            surfaceSendError(error)
            throw error
        }
    }

    private func commandRoute(forAgentActorID agentActorID: String?,
                              fallbackRuntime: Runtime?) -> (runtimeID: String, actorID: String) {
        let key = agentActorID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let targetRuntimeID: String = {
            guard !key.isEmpty else { return fallbackRuntime?.runtimeId ?? "" }
            if let mapped = runtimeID(forAgentActorID: key), !mapped.isEmpty { return mapped }
            if fallbackRuntime?.runtimeId == key { return key }
            if memberSheetAgents.contains(where: { $0.id == key }) { return "" }
            return key
        }()

        let actorID: String = {
            if !key.isEmpty, let id = routeActorID(forAgentActorID: key), !id.isEmpty { return id }
            if fallbackRuntime?.runtimeId == targetRuntimeID,
               let id = fallbackRuntime?.routeActorID,
               !id.isEmpty {
                return id
            }
            if let ctx = startModelContext, !targetRuntimeID.isEmpty {
                let rid = targetRuntimeID
                let desc = FetchDescriptor<Runtime>(predicate: #Predicate { $0.runtimeId == rid })
                if let id = (try? ctx.fetch(desc).first?.routeActorID), !id.isEmpty { return id }
            }
            return resolveRouteActorID()
        }()

        return (targetRuntimeID, actorID)
    }

    public func sendPrompt(_ text: String, modelId: String? = nil, attachmentURLs: [URL] = [], modelContext: ModelContext? = nil) async throws {
        if let session, let teamclawService {
            // Session-backed chats use the session live stream as the
            // canonical messaging channel so other collaborators see the
            // user's prompt too. The daemon subscribes to session/{sid}/live
            // and forwards each message to its bound ACP runtime.
            //
            // Body composition: prepend `@<displayName> ` for any lit chip
            // that the user hasn't already typed inline. The auto-light
            // single-agent default would otherwise produce a body without
            // any visible mention even though the chip is engaging an
            // agent — confusing in chat history, especially for other
            // collaborators reading along.
            let body = composeBodyWithMentions(text)
            let messageID = UUID().uuidString
            let mentionIDs = Array(agentChipSelection)
            AnalyticsSink.track("message_sent", [
                "agentCount": String(mentionIDs.count),
                "hasAttachments": String(!attachmentURLs.isEmpty),
            ])

            // 1. Local user_prompt entry for the bubble. The
            //    reducer's .localPrompt path stamps `outboxMessageID =
            //    clientID` onto the entry so the chat view's
            //    status-dot accessory binds correctly. Apply +
            //    project; the sync layer inserts the matching
            //    AgentEvent row.
            if let ctx = modelContext ?? startModelContext {
                let dirty = applyTimelineInput(
                    .localPrompt(LocalPromptInput(
                        clientID: messageID,
                        senderActorID: teamclawService.currentHumanActorId ?? "",
                        content: body,
                        createdAt: .now
                    )),
                    modelContext: ctx
                )
                if dirty { recomputeGroups() }
            }

            // Flip the busy flag immediately on send so the chip-bar
            // stop button surfaces without waiting for the first ACP
            // event to round-trip. The 10s safety reset still fires;
            // the first real ACP event resets the timer.
            markAgentWorking()

            // 2. Hand the body off to the outbox. The sender loop will
            //    drive MQTT publish + Supabase persist with retries.
            //    Falls back to the legacy synchronous path when the
            //    outbox sender hasn't been wired in (e.g. tests).
            if let outboxSender {
                await outboxSender.enqueue(
                    messageID: messageID,
                    sessionID: session.sessionId,
                    senderActorID: teamclawService.currentHumanActorId ?? "",
                    content: body,
                    mentionActorIDs: mentionIDs,
                    modelID: modelId,
                    attachmentURLs: attachmentURLs
                )
                return
            }

            // Legacy (test/no-outbox) fallback: send synchronously and
            // surface the error inline. Production view-paths always
            // construct an OutboxSender so this branch is exercised
            // primarily by unit tests / earlier-API callers.
            do {
                _ = try await teamclawService.sendMessage(
                    sessionId: session.sessionId,
                    content: body,
                    modelId: modelId,
                    mentionActorIDs: mentionIDs,
                    attachmentURLs: attachmentURLs,
                    messageID: messageID
                )
            } catch {
                surfaceSendError(error)
                throw error
            }
        } else if runtime != nil {
            // Legacy runtime-only flow (no session): send via ACP command.
            let seq = (events.last?.sequence ?? 0) + 1
            let userEvent = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "user_prompt")
            userEvent.text = text
            userEvent.senderActorID = teamclawService?.currentHumanActorId
            if let ctx = modelContext ?? syncModelContext { ctx.insert(userEvent); try? ctx.save() }
            appendEvent(userEvent)
            recomputeGroups()

            var p = Amux_AcpSendPrompt(); p.text = text
            if let modelId, !modelId.isEmpty {
                p.modelID = modelId
            }
            if !attachmentURLs.isEmpty {
                p.attachmentUrls = attachmentURLs.map(\.absoluteString)
            }
            try await sendCommand { $0.command = .sendPrompt(p) }
        }
    }
    @MainActor
    private func surfaceSendError(_ error: Error) {
        sendErrorMessage = error.localizedDescription
        errorClearTask?.cancel()
        errorClearTask = Task { [weak self, errorMessageTTL] in
            try? await Task.sleep(for: .seconds(errorMessageTTL))
            guard let self, !Task.isCancelled else { return }
            self.sendErrorMessage = nil
        }
    }

    public func cancelTask() async throws {
        try await sendCommand { $0.command = .cancel(Amux_AcpCancel()) }
        // Same wait-for-idle semantics as interruptAgent: the bound
        // runtime's bucket settles when the daemon acknowledges, with
        // the timeout as backstop. No optimistic global clear.
        if let bucket = bucketKey(forRuntimeID: runtime?.runtimeId) {
            interruptPendingAgents.insert(bucket)
            armInterruptAckTimeout(for: bucket)
        }
    }

    // MARK: - Edit / delete own persisted messages
    //
    // Remote-first on purpose: FC's PATCH/DELETE is the authority (it
    // enforces sender-only semantics), so the local bubble only changes
    // after the server accepted the mutation — a failed call leaves the
    // feed untouched and surfaces through the same inline error banner
    // as a failed send. Only events that carry a `supabaseMessageId`
    // qualify, which the UI guarantees before offering the actions.

    /// Rewrites the content of one of the current user's persisted
    /// prompts, remote then local.
    public func editUserMessage(supabaseMessageID: String, newContent: String) async {
        guard let repo = messagesRepository else { return }
        let content = newContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        do {
            try await repo.patch(messageID: supabaseMessageID, content: content)
        } catch {
            surfaceSendError(error)
            return
        }
        guard let ctx = startModelContext ?? syncModelContext else { return }
        for idx in timelineState.entries.indices
        where timelineState.entries[idx].supabaseMessageID == supabaseMessageID {
            timelineState.entries[idx].text = content
        }
        projectTimelineStateMutation(modelContext: ctx)
        updateSessionMessageCache(messageID: supabaseMessageID, content: content, modelContext: ctx)
    }

    /// Permanently removes one of the current user's persisted prompts,
    /// remote then local.
    public func deleteUserMessage(supabaseMessageID: String) async {
        guard let repo = messagesRepository else { return }
        do {
            try await repo.delete(messageID: supabaseMessageID)
        } catch {
            surfaceSendError(error)
            return
        }
        guard let ctx = startModelContext ?? syncModelContext else { return }
        // Dropping the entry from reducer state is enough — the sync layer
        // deletes any AgentEvent row whose id fell out of state.entries,
        // so there is no separate SwiftData bookkeeping to keep in step.
        timelineState.entries.removeAll { $0.supabaseMessageID == supabaseMessageID }
        projectTimelineStateMutation(modelContext: ctx)
        updateSessionMessageCache(messageID: supabaseMessageID, content: nil, modelContext: ctx)
    }

    /// Shared tail for the direct `timelineState.entries` mutations above.
    /// They bypass the reducer (there is no TimelineInput for "the user
    /// rewrote history"), so the projection + recompute that
    /// `applyTimelineInput`'s `.entriesChanged` arm performs has to be
    /// invoked manually here.
    private func projectTimelineStateMutation(modelContext: ModelContext) {
        let dirty = TimelineSwiftDataSync.sync(
            state: timelineState,
            into: &events,
            agentId: eventScopeKey,
            modelContext: modelContext
        )
        if dirty {
            sortEventsForDisplay()
            recomputeGroups()
        }
    }

    /// Keeps the `SessionMessage` mirror (session-list previews, sender
    /// clusters) consistent with a remote edit/delete. `content == nil`
    /// means the row was deleted. Missing row is fine — the cache only
    /// holds messages that arrived over the live stream on this device.
    private func updateSessionMessageCache(messageID: String, content: String?, modelContext: ModelContext) {
        let mid = messageID
        let descriptor = FetchDescriptor<SessionMessage>(predicate: #Predicate { $0.messageId == mid })
        guard let row = try? modelContext.fetch(descriptor).first else { return }
        if let content {
            row.content = content
        } else {
            modelContext.delete(row)
        }
        try? modelContext.save()
    }

    /// Flip isAgentWorking on and arm a long safety reset so a missed
    /// `statusChange:.idle` event doesn't leave the chip stuck in stop.
    /// Also rebuilds `feedItems` so the active-stream "Agent loading"
    /// card appears synchronously — without this, the card would only
    /// surface on the next `recomputeGroups()` trigger (the first ACP
    /// runtime event), which is the latency the user sees on send.
    ///
    /// The reset window (60s) covers a cold-spawn agent's first-delta
    /// latency so the pending card doesn't get cleared mid-wait. The view
    /// layer switches the label to a "请耐心等候" variant after ~15s so
    /// the user knows we're still waiting rather than the indicator
    /// silently dropping.
    private func markAgentWorking() {
        isAgentWorking = true
        recomputeGroups()
        armAgentWorkingSafetyReset()
    }

    /// (Re)arm the 60s safety reset. Split from `markAgentWorking` so the
    /// timeout handler can re-arm itself without flipping the flag.
    private func armAgentWorkingSafetyReset() {
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard let self, !Task.isCancelled else { return }
            await MainActor.run {
                self.handleAgentWorkingSafetyTimeout()
            }
        }
    }

    /// Safety-timer expiry. Clearing `isAgentWorking` is only safe when no
    /// stream is in flight: with a non-empty `streamingAgentSet`, 60 s of
    /// event silence just means a long thinking / tool stretch, and the
    /// old unconditional clear raced the real settle paths — the timer
    /// wiped the flag mid-stream, then a late idle/event operated on
    /// already-cleared state. Re-arm for another period instead; the real
    /// `statusChange:.idle` (or the interrupt settle) owns the flag while
    /// any agent is streaming.
    private func handleAgentWorkingSafetyTimeout() {
        guard streamingAgentSet.isEmpty else {
            armAgentWorkingSafetyReset()
            return
        }
        isAgentWorking = false
        recomputeGroups()
    }

    private func markAgentDone() {
        isAgentWorking = false
        streamingAgentSet.removeAll()
        streamingTextByAgent.removeAll()
        streamingModelByAgent.removeAll()
        streamingTurnIDByAgent.removeAll()
        timelineState.streamingAgentSet = []
        timelineState.streamingTextByAgent = [:]
        timelineState.streamingModelByAgent = [:]
        timelineState.streamingTurnIDByAgent = [:]
        recomputeGroups()
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = nil
    }

    /// Per-agent turn settle on `statusChange:.idle`. By the time this
    /// runs, the reducer has already flushed the bucket's partial text
    /// into a completed entry and cleared its streaming slots (see
    /// `ChatTimelineReducer` `.statusChange`), and `applyTimelineInput`
    /// mirrored the result. Only the VM-level side effects the reducer
    /// doesn't own happen here — and nothing global: other agents'
    /// in-flight streams must survive one agent finishing.
    private func settleAgentTurn(bucket: String) {
        interruptTimeoutTasks[bucket]?.cancel()
        interruptTimeoutTasks[bucket] = nil
        interruptPendingAgents.remove(bucket)
        // Single session-level "working" chip: idle from any runtime
        // drops it; the next real work event from a still-running agent
        // flips it back on (handleAcpEvent → markAgentWorking).
        isAgentWorking = false
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = nil
        recomputeGroups()
    }

    /// Arm the ack-timeout fallback for an in-flight cancel. Resolved
    /// early (cancelled) when the daemon's real `statusChange:.idle`
    /// arrives via `settleAgentTurn`.
    private func armInterruptAckTimeout(for bucket: String) {
        interruptTimeoutTasks[bucket]?.cancel()
        interruptTimeoutTasks[bucket] = Task { [weak self, interruptAckTimeout] in
            try? await Task.sleep(for: .seconds(interruptAckTimeout))
            guard let self, !Task.isCancelled else { return }
            self.forceSettleInterruptedAgent(bucket)
        }
    }

    /// Timeout leg: the daemon never acknowledged the cancel. Synthesize
    /// the `statusChange:.idle` locally and run it through the normal
    /// reducer path, so the partial text lands as a completed entry
    /// exactly as a real idle would — then settle the bucket.
    private func forceSettleInterruptedAgent(_ bucket: String) {
        interruptTimeoutTasks[bucket] = nil
        guard interruptPendingAgents.contains(bucket) else { return }
        guard let ctx = startModelContext else {
            interruptPendingAgents.remove(bucket)
            return
        }
        var sc = Amux_AcpStatusChange()
        sc.newStatus = .idle
        var acp = Amux_AcpEvent()
        acp.event = .statusChange(sc)
        let seq = UInt64(max(events.last?.sequence ?? 0, 0)) + 1
        let dirty = applyTimelineInput(
            .acp(AcpInput(
                envelopeSequence: seq,
                runtimeID: "",
                agentBucketKey: bucket,
                timestamp: .now,
                turnID: streamingTurnIDByAgent[bucket],
                acpEvent: acp
            )),
            modelContext: ctx
        )
        if dirty { try? ctx.save() }
        settleAgentTurn(bucket: bucket)
    }

    // MARK: - Phase 4 reducer apply + project

    /// Apply one input to the reducer, mirror the reducer-owned auxiliary
    /// state (streaming buffers, availableCommands) onto the VM's
    /// @Observable fields, then project entries into the SwiftData-backed
    /// `events` **only when the reducer changed entries**. Returns `true`
    /// iff the projection mutated the SwiftData `events` array.
    ///
    /// **Fast path:** streaming deltas after the first one return
    /// `.streamingBufferOnly` from the reducer — `state.entries` is
    /// byte-identical. We skip the O(N log N) sort and the O(N) SwiftData
    /// diff entirely, saving the main-thread work that dominated Time
    /// Profiler samples during streaming (dozens of frames per second).
    @discardableResult
    private func applyTimelineInput(_ input: TimelineInput,
                                    modelContext: ModelContext) -> Bool {
        let effect = ChatTimelineReducer.apply(input, to: &timelineState)

        if !timelineState.availableCommands.isEmpty {
            dynamicAvailableCommands = timelineState.availableCommands
        }

        switch effect {
        case .noop:
            mirrorReducerStreamingState()
            return false
        case .streamingBufferOnly:
            // Hot path: only the text buffer grew — entries are
            // byte-identical, so we skip sort + SwiftData diff. The
            // @Observable mirror is throttled too: at delta rates every
            // per-token assignment invalidates ActiveStreamCardView /
            // StreamingDetailView for a render pass, so coalesce to at
            // most one mirror per interval. The first delta of a stream
            // arrives via `.entriesChanged` and mirrors immediately.
            scheduleStreamingMirrorFlush()
            #if DEBUG
            SessionDetailViewModel._testFastPathSkipCount &+= 1
            #endif
            return false
        case .entriesChanged:
            mirrorReducerStreamingState()
            timelineState.entries.sort {
                if $0.timestamp != $1.timestamp { return $0.timestamp < $1.timestamp }
                if $0.sequence != $1.sequence { return $0.sequence < $1.sequence }
                return $0.id < $1.id
            }
            return TimelineSwiftDataSync.sync(
                state: timelineState,
                into: &events,
                agentId: eventScopeKey,
                modelContext: modelContext
            )
        }
    }

    /// Mirror the reducer-owned streaming buffers onto the VM's
    /// @Observable fields. These drive ActiveStreamCardView last-line and
    /// StreamingDetailView live text. Called synchronously on every
    /// entries-changing input and on a throttle for pure text-growth deltas.
    private func mirrorReducerStreamingState() {
        streamingMirrorFlushTask?.cancel()
        streamingMirrorFlushTask = nil
        streamingTextByAgent = timelineState.streamingTextByAgent
        streamingModelByAgent = timelineState.streamingModelByAgent
        streamingAgentSet = timelineState.streamingAgentSet
        streamingTurnIDByAgent = timelineState.streamingTurnIDByAgent
    }

    /// Throttle leg of `mirrorReducerStreamingState` for the per-token
    /// hot path. Keeps the latest reducer text flowing to the UI at
    /// ~10 Hz instead of once per delta. A pending flush is left in
    /// place (not rescheduled) so a continuous stream flushes on a
    /// steady cadence; immediate mirrors cancel it because they already
    /// publish strictly newer state.
    private func scheduleStreamingMirrorFlush() {
        guard streamingMirrorFlushTask == nil else { return }
        streamingMirrorFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard let self, !Task.isCancelled else { return }
            self.streamingMirrorFlushTask = nil
            self.streamingTextByAgent = self.timelineState.streamingTextByAgent
            self.streamingModelByAgent = self.timelineState.streamingModelByAgent
            self.streamingAgentSet = self.timelineState.streamingAgentSet
            self.streamingTurnIDByAgent = self.timelineState.streamingTurnIDByAgent
        }
    }

    /// Rehydrate the reducer's entry state from the SwiftData-loaded
    /// `events` at view-mount time. Without this, the first reducer
    /// applies dedup against an empty state and we'd duplicate every
    /// historical row.
    ///
    /// Streaming buffers are reset to empty: a stop()/start() cycle
    /// (triggered by every NavigationStack push of `StreamingDetailView`)
    /// re-enters this function, and the reducer-owned streaming state
    /// from before the stop is now stale — the matching SwiftData
    /// state was already persisted as a synthetic incomplete-output
    /// entry by `stop()`. Leaving the prior streaming set in place
    /// would short-circuit the `.output(notComplete)` first-delta
    /// path on the next delta (set already contains the bucket), so
    /// the synthetic never gets absorbed, accumulates as orphan
    /// entries in `state.entries`, and bleeds into every subsequent
    /// completedTurn's `runtimeEvents`.
    private func rehydrateTimelineStateFromEvents() {
        timelineState.entries = events.map { event in
            TimelineEntry(
                id: event.id,
                sequence: UInt64(max(event.sequence, 0)),
                eventType: event.eventType,
                text: event.text,
                toolID: event.toolId,
                toolName: event.toolName,
                isComplete: event.isComplete,
                success: event.success,
                senderActorID: event.senderActorID,
                timestamp: event.timestamp,
                model: event.model,
                supabaseMessageID: event.supabaseMessageId,
                outboxMessageID: event.outboxMessageID,
                turnID: event.turnID
            )
        }
        timelineState.streamingTextByAgent = [:]
        timelineState.streamingModelByAgent = [:]
        timelineState.streamingAgentSet = []
        timelineState.streamingTurnIDByAgent = [:]
    }

    /// After a stop()/start() cycle (e.g. NavigationStack push/pop) or a
    /// cold relaunch, check if any persisted incomplete-output events exist
    /// in `events`. If so, agents were mid-stream when stop() (or the
    /// background snapshot) flushed their buffers; restore the streaming
    /// set so every agent's active-stream card reappears immediately
    /// instead of waiting for the next MQTT delta. Multi-agent: stop()
    /// persists one synthetic row per streaming agent — each agent's
    /// NEWEST row wins (the old single-index path restored only the last
    /// row overall, dropping every other agent's text and turn id).
    ///
    /// Runtime-status guard: skip restore only when the bound runtime is
    /// known-settled (3=Idle 4=Error 5=Stopped) — a leftover row then
    /// belongs to a finished turn and must not re-trigger the loading
    /// card. `nil` status (collab-only session, runtime row not resolved
    /// yet) means "unknown" and restores: the synthetic rows are
    /// themselves evidence a stream was live moments ago, and a stale
    /// restore is converged back down by the Supabase seed's
    /// residual-streaming cleanup (reducer `.historyMessage`) and the
    /// reconnect turn replay.
    private func restoreStreamingAgentSetFromIncompleteOutput() {
        // Runtime status ints: 1=Starting 2=Active 3=Idle 4=Error 5=Stopped.
        if let runtimeStatus = runtime?.status, runtimeStatus != 1, runtimeStatus != 2 { return }

        var rowsByAgent: [String: [AgentEvent]] = [:]
        for event in events where event.eventType == "output" && event.isComplete == false {
            guard let text = event.text, !text.isEmpty else { continue }
            rowsByAgent[event.senderActorID ?? eventScopeKey, default: []].append(event)
        }
        guard !rowsByAgent.isEmpty else { return }

        for (agentID, rows) in rowsByAgent {
            guard let latest = rows.max(by: {
                ($0.sequence, $0.timestamp) < ($1.sequence, $1.timestamp)
            }) else { continue }
            let text = latest.text ?? ""
            streamingTextByAgent[agentID] = text
            timelineState.streamingTextByAgent[agentID] = text
            if let model = latest.model {
                streamingModelByAgent[agentID] = model
                timelineState.streamingModelByAgent[agentID] = model
            }
            if let turnID = latest.turnID, !turnID.isEmpty {
                streamingTurnIDByAgent[agentID] = turnID
                timelineState.streamingTurnIDByAgent[agentID] = turnID
            }
            streamingAgentSet.insert(agentID)
            timelineState.streamingAgentSet.insert(agentID)

            // Drop the synthetic rows now that their bytes live in the
            // streaming buffer. Keeping them would render the same text
            // twice (bubble + active-stream card) and strand an orphan
            // incomplete entry after the idle flush appends the completed
            // one — the reducer's firstDelta synthetic absorption can't
            // fire once the bucket is already in streamingAgentSet.
            for row in rows {
                if let idx = events.firstIndex(where: { $0 === row }) {
                    removeEvent(at: idx)
                }
                let rowID = row.id
                timelineState.entries.removeAll { $0.id == rowID }
                startModelContext?.delete(row)
            }
        }
        try? startModelContext?.save()
        recomputeGroups()
    }

    public func grantPermission(
        requestId: String,
        agentActorID: String? = nil,
        optionID: String = ""
    ) async throws {
        guard inFlightPermissionRequestIDs.insert(requestId).inserted else { return }
        defer { inFlightPermissionRequestIDs.remove(requestId) }
        var g = Amux_AcpGrantPermission()
        g.requestID = requestId
        g.optionID = optionID
        try await sendCommand(agentActorID: agentActorID) { $0.command = .grantPermission(g) }
    }
    public func denyPermission(requestId: String, agentActorID: String? = nil) async throws {
        guard inFlightPermissionRequestIDs.insert(requestId).inserted else { return }
        defer { inFlightPermissionRequestIDs.remove(requestId) }
        var d = Amux_AcpDenyPermission(); d.requestID = requestId
        try await sendCommand(agentActorID: agentActorID) { $0.command = .denyPermission(d) }
    }
}

// MARK: - Test seams (DEBUG only)

#if DEBUG
extension SessionDetailViewModel {
    /// Builds a minimal VM suitable for unit tests. Uses a stub MQTTService
    /// (no network) and no session/runtime context.
    public static func testInstance() -> SessionDetailViewModel {
        let mqtt = MQTTService()
        return SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "test-team",
            peerId: "test-peer"
        )
    }

    /// Builds a VM with a `Session` inserted into an in-memory SwiftData
    /// container and calls `bind(session:modelContext:)` so that chip-bar
    /// mutations are persisted to `session.selectedAgentIds`.
    @MainActor
    public static func testInstance(session: Session) -> SessionDetailViewModel {
        let mqtt = MQTTService()
        let container = try! ModelContainer(
            for: Session.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        ctx.insert(session)
        let vm = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "test-team",
            peerId: "test-peer"
        )
        vm.bind(session: session, modelContext: ctx)
        return vm
    }

    // NSMapTable with weak keys: the container lives as long as the VM does,
    // then both are released together when the test runner deallocates the VM.
    private static let _testStorage = NSMapTable<SessionDetailViewModel, ModelContainer>(
        keyOptions: .weakMemory, valueOptions: .strongMemory
    )

    /// Calls the private `handleIncomingChatMessage` via a per-VM in-memory
    /// ModelContainer whose lifetime is tied to this VM instance. Using a
    /// single retained container prevents the "model instance was destroyed"
    /// crash that occurred when a locally-scoped container was released before
    /// test assertions could read back inserted objects from `vm.events`.
    public func _test_handleIncomingChatMessage(_ message: Teamclaw_Message) {
        let container: ModelContainer
        if let existing = Self._testStorage.object(forKey: self) {
            container = existing
        } else {
            guard let fresh = try? ModelContainer(
                for: AgentEvent.self,
                configurations: ModelConfiguration(isStoredInMemoryOnly: true)
            ) else { return }
            Self._testStorage.setObject(fresh, forKey: self)
            container = fresh
        }
        handleIncomingChatMessage(message, modelContext: container.mainContext)
    }

    /// Drive the post-load behaviour of `refreshMemberSheet` directly:
    /// set the agent roster + run the raw-runtime-id relabel pass. Lets
    /// tests exercise the bucket reconciliation without standing up a
    /// Supabase loader.
    public func _test_setMemberSheetAgentsAndRelabel(_ agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
        relabelRawRuntimeIDStampsToActorIDs()
    }

    public func _test_setMemberSheetAgents(_ agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
    }

    public func _test_applyOptimisticModelPatch(agentID: String, model: String) {
        applyOptimisticModelPatch(agentID: agentID, model: model)
    }

    public func _test_rollbackOptimisticModelPatch(agentID: String, previousModel: String?) {
        rollbackOptimisticModelPatch(agentID: agentID, previousModel: previousModel)
    }

    public func _test_markPermissionInFlight(_ id: String) {
        inFlightPermissionRequestIDs.insert(id)
    }

    public func _test_removePermissionInFlight(_ id: String) {
        inFlightPermissionRequestIDs.remove(id)
    }

    public func _test_isPermissionInFlight(_ id: String) -> Bool {
        inFlightPermissionRequestIDs.contains(id)
    }

    /// Returns true if the id was NOT already in flight (i.e. the call should proceed).
    public func _test_tryMarkInFlight(_ id: String) -> Bool {
        inFlightPermissionRequestIDs.insert(id).inserted
    }

    /// Returns whether the current member sheet state would cause
    /// scheduleSpawningRefreshIfNeeded() to enqueue a poll.
    public func _test_needsSpawningPoll() -> Bool {
        memberSheetAgents.contains {
            $0.runtimeState == .spawning
            || $0.runtimeID == nil
            || ($0.availableModels.isEmpty
                && ($0.runtimeState == .active
                    || $0.runtimeState == .idle
                    || $0.runtimeState == .ready))
        }
    }

    /// Exposes the partial-retain merge logic for testing.
    public static func _test_mergeAvailableModels(liveModels: [String], existingModels: [String]) -> [String] {
        if !liveModels.isEmpty { return liveModels }
        if !existingModels.isEmpty { return existingModels }
        return []
    }

    /// Append a raw event to in-memory `events` + `timelineState.entries`
    /// the same way the production live path would, without going through
    /// the reducer. Lets tests seed pre-memberSheet stamps.
    public func _test_appendRawEvent(senderActorID: String, eventType: String, text: String) {
        let event = AgentEvent(agentId: eventScopeKey, sequence: events.count + 1, eventType: eventType)
        event.senderActorID = senderActorID
        event.text = text
        events.append(event)
        timelineState.entries.append(TimelineEntry(
            id: event.id,
            sequence: UInt64(event.sequence),
            eventType: eventType,
            text: text,
            isComplete: false,
            senderActorID: senderActorID,
            timestamp: event.timestamp
        ))
    }

    /// Inject a streaming-buffer entry as if a live ACP output delta had
    /// landed under `bucket` before memberSheet finished loading.
    public func _test_seedStreamingBuffer(bucket: String, text: String, model: String? = nil, turnID: String? = nil) {
        timelineState.streamingAgentSet.insert(bucket)
        timelineState.streamingTextByAgent[bucket] = text
        if let model { timelineState.streamingModelByAgent[bucket] = model }
        if let turnID { timelineState.streamingTurnIDByAgent[bucket] = turnID }
        streamingAgentSet = timelineState.streamingAgentSet
        streamingTextByAgent = timelineState.streamingTextByAgent
        streamingModelByAgent = timelineState.streamingModelByAgent
        streamingTurnIDByAgent = timelineState.streamingTurnIDByAgent
    }

    public func _test_markAgentDone() {
        markAgentDone()
    }

    public func _test_markAgentWorking() {
        markAgentWorking()
    }

    /// Run the 60s safety-timer expiry synchronously (no sleeping in tests).
    public func _test_fireAgentWorkingSafetyTimeout() {
        handleAgentWorkingSafetyTimeout()
    }

    public var _test_streamingTurnIDByAgent: [String: String] {
        streamingTurnIDByAgent
    }

    public var _test_pendingTurnReplayBuckets: Set<String> {
        pendingTurnReplayBuckets
    }

    public func _test_turnReplayRuntimeID(forBucket bucket: String) -> String? {
        turnReplayRuntimeID(forBucket: bucket)
    }

    public func _test_replayStreamingTurnsAfterReconnect(modelContext: ModelContext) async {
        startModelContext = modelContext
        await replayStreamingTurnsAfterReconnect(modelContext: modelContext)
    }

    public func _test_makeInMemoryContainer() -> ModelContainer {
        (try? ModelContainer(
            for: AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        ))!
    }

    /// Simulates stop(): flushes streaming buffers to incomplete events in
    /// `modelContext`, then clears all streaming state. Bypasses the
    /// `runtime != nil` guard so unit tests without a live runtime can exercise
    /// the flush path.
    public func _test_stop(modelContext: ModelContext) {
        startModelContext = modelContext
        mirrorReducerStreamingState()
        var seq = (events.last?.sequence ?? 0) + 1
        for agentID in streamingAgentSet {
            guard let text = streamingTextByAgent[agentID], !text.isEmpty else { continue }
            let event = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "output")
            event.senderActorID = agentID
            event.text = text
            event.isComplete = false
            event.model = streamingModelByAgent[agentID]
            event.turnID = streamingTurnIDByAgent[agentID]
            modelContext.insert(event)
            appendEvent(event)
            seq += 1
        }
        try? modelContext.save()
        streamingAgentSet.removeAll()
        streamingTextByAgent.removeAll()
        streamingModelByAgent.removeAll()
        streamingTurnIDByAgent.removeAll()
        recomputeGroups()
    }

    /// Simulates start(): reloads events from `modelContext` and restores
    /// streaming state from any persisted incomplete output events.
    public func _test_start(modelContext: ModelContext) {
        startModelContext = modelContext
        let scope = eventScopeKey
        let descriptor = FetchDescriptor<AgentEvent>(
            predicate: #Predicate { $0.agentId == scope },
            sortBy: [SortDescriptor(\.timestamp), SortDescriptor(\.sequence)]
        )
        events = (try? modelContext.fetch(descriptor)) ?? []
        rehydrateTimelineStateFromEvents()
        restoreStreamingAgentSetFromIncompleteOutput()
    }
}

extension SessionParticipant {
    public static func testFixture(actorID: String, role: String, displayName: String) -> SessionParticipant {
        SessionParticipant(actorID: actorID, role: role, displayName: displayName)
    }
}

extension MemberSheetAgent {
    public static func testFixture(
        id: String,
        displayName: String? = nil
    ) -> MemberSheetAgent {
        MemberSheetAgent(
            id: id,
            displayName: displayName ?? id,
            workspacePath: "",
            agentType: "claude",
            runtimeState: .idle,
            availableModels: [],
            currentModel: nil,
            runtimeID: nil,
            workspaceID: nil,
            backendType: nil
        )
    }
}

extension SessionDetailViewModel {
    /// Sets `memberSheetAgents` to the given snapshot and prunes any ghost
    /// agent IDs from `agentChipSelection`. For use in unit tests only.
    @MainActor
    public func applyMemberSheetSnapshotForTests(agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
        pruneGhostAgentSelection()
    }
}

extension SessionDetailViewModel {
    /// Counts fast-path skips (streaming-buffer-only deltas that bypassed
    /// sort + SwiftData sync). Incremented by `applyTimelineInput` only in
    /// DEBUG builds. Stored on the type to avoid the stored-property-in-
    /// extension restriction on @Observable classes; tests that call this
    /// should be serial to avoid data races on the counter.
    nonisolated(unsafe) public static var _testFastPathSkipCount: Int = 0

    /// Synchronously run the throttled streaming-buffer mirror so tests
    /// can assert on the @Observable fields without sleeping through the
    /// flush interval.
    @MainActor
    public func _testFlushStreamingMirror() {
        mirrorReducerStreamingState()
    }

    /// Direct test entry: run a full ACP event through `handleAcpEvent`
    /// (reducer + VM side effects like per-agent idle settle) without a
    /// live MQTT session. `runtimeID` doubles as the bucket key when it
    /// isn't in `memberSheetAgents` (raw-id fallback in `bucketKey`).
    @MainActor
    public func _testHandleAcp(_ acp: Amux_AcpEvent,
                               sequence: Int,
                               runtimeID: String,
                               modelContext: ModelContext) {
        startModelContext = modelContext
        _ = handleAcpEvent(acp, sequence: sequence, runtimeID: runtimeID,
                           modelContext: modelContext)
    }

    /// Simulate an in-flight cancel (membership only, no MQTT publish)
    /// and immediately run the ack-timeout leg, so tests can exercise
    /// the force-settle path without sleeping through the timeout.
    @MainActor
    public func _testForceSettleInterrupt(bucket: String, modelContext: ModelContext) {
        startModelContext = modelContext
        interruptPendingAgents.insert(bucket)
        forceSettleInterruptedAgent(bucket)
    }

    /// Direct test entry: build an AcpInput and run it through
    /// `applyTimelineInput` without a live MQTT session.
    @MainActor
    public func _testApplyAcp(_ acp: Amux_AcpEvent,
                              sequence: Int,
                              runtimeID: String,
                              agentBucketKey: String,
                              modelContext: ModelContext) {
        _ = applyTimelineInput(
            .acp(AcpInput(
                envelopeSequence: UInt64(sequence),
                runtimeID: runtimeID,
                agentBucketKey: agentBucketKey,
                timestamp: .now,
                turnID: nil,
                acpEvent: acp
            )),
            modelContext: modelContext
        )
    }
}
#endif
