import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

// MARK: - SessionDetailView (iMessage-style chat detail)

public struct SessionDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel: SessionDetailViewModel
    /// Single actor-directory query shared by all EventBubbleView instances
    /// in this session, replacing per-row @Query registrations.
    @Query(sort: \CachedActor.displayName) private var cachedActors: [CachedActor]
    private var cachedActorMap: CachedActorMap {
        CachedActorMap(nameByActorID: Dictionary(uniqueKeysWithValues: cachedActors.map { ($0.actorId, $0.displayName) }))
    }
    @State private var promptText = ""
    @State private var attachments: [URL] = []
    @State private var voiceRecorder = VoiceRecorder(contextualStrings: [
        "Claude", "Claude Code", "Sonnet", "Opus", "Haiku",
        "MQTT", "protobuf", "SwiftUI", "SwiftData",
        "agent", "daemon", "worktree", "workspace",
        "commit", "push", "merge", "pull request",
        "API", "JSON", "YAML", "REST", "gRPC",
    ])
    @State private var isMemberSheetPresented: Bool = false
    @State private var isAddAgentSheetPresented: Bool = false
    @State private var isAddMemberSheetPresented: Bool = false
    @State private var muted = false
    @State private var isPlansPanelPresented: Bool = false
    @State private var plansPageIndex: Int = 0
    @State private var hasAutoOpenedPlans: Bool = false
    @State private var isInitialFeedVisible: Bool = false
    @State private var initialAutoScrollSettled: Bool = false
    @State private var isAtBottom: Bool = true
    @State private var scrollProxy: ScrollViewProxy? = nil
    /// User-prompt bubble currently being edited (drives the edit sheet).
    @State private var editingEvent: AgentEvent?
    /// User-prompt bubble pending delete confirmation (drives the dialog).
    @State private var pendingDeleteEvent: AgentEvent?
    private let nearBottomThreshold: CGFloat = 80
    /// Cached TeamclawService used to lazily build the OutboxSender once
    /// the modelContext (and therefore its container) is available.
    private let pendingTeamclawService: TeamclawService?
    private let pushPrefs: (any PushPreferencesAPI)?
    /// Preferred mute backend — the team-runtime store keeps the session
    /// list's muted set in sync with toggles made here. `pushPrefs` stays
    /// as the fallback for hosts that don't carry a team runtime.
    private let notificationPrefsStore: NotificationPrefsStore?
    private let workspacesRepository: (any WorkspaceRepository)?

    let connectedAgentsStore: ConnectedAgentsStore?

    public init(runtime: Runtime, mqtt: MQTTService, hub: MQTTMessageHub, peerId: String,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                messagesRepository: (any MessagesRepository)? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                pushPrefs: (any PushPreferencesAPI)? = nil,
                notificationPrefsStore: NotificationPrefsStore? = nil) {
        _viewModel = State(initialValue: SessionDetailViewModel(
            runtime: runtime, mqtt: mqtt, hub: hub, peerId: peerId,
            connectedAgentsStore: connectedAgentsStore,
            sessionsRepository: sessionsRepository,
            messagesRepository: messagesRepository,
            workspacesRepository: workspacesRepository))
        self.connectedAgentsStore = connectedAgentsStore
        self.pendingTeamclawService = nil
        self.pushPrefs = pushPrefs
        self.notificationPrefsStore = notificationPrefsStore
        self.workspacesRepository = workspacesRepository
    }

    public init(session: Session, mqtt: MQTTService, hub: MQTTMessageHub, peerId: String,
                teamclawService: TeamclawService?,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                messagesRepository: (any MessagesRepository)? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                pushPrefs: (any PushPreferencesAPI)? = nil,
                notificationPrefsStore: NotificationPrefsStore? = nil) {
        _viewModel = State(initialValue: SessionDetailViewModel(
            runtime: nil, mqtt: mqtt, hub: hub, teamID: session.teamId,
            peerId: peerId, session: session,
            teamclawService: teamclawService,
            connectedAgentsStore: connectedAgentsStore,
            sessionsRepository: sessionsRepository,
            messagesRepository: messagesRepository,
            workspacesRepository: workspacesRepository))
        self.connectedAgentsStore = connectedAgentsStore
        self.pendingTeamclawService = teamclawService
        self.pushPrefs = pushPrefs
        self.notificationPrefsStore = notificationPrefsStore
        self.workspacesRepository = workspacesRepository
    }

    public var body: some View {
        VStack(spacing: 0) {
            if !viewModel.isDaemonOnline {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.slash").font(.caption)
                    Text("Daemon offline").font(.caption).fontWeight(.medium)
                }
                .foregroundStyle(Color.amux.basalt)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                // Hai banners stay quiet — Pebble fill instead of system
                // orange. Vermillion is rationed for active session sends.
                .background(Capsule().fill(Color.amux.pebble.opacity(0.7)))
                .overlay(Capsule().stroke(Color.amux.hairline, lineWidth: 0.5))
                .padding(.vertical, 4)
            }
            if let sendError = viewModel.sendErrorMessage {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.caption)
                    Text(sendError).font(.caption).fontWeight(.medium)
                }
                .foregroundStyle(Color.amux.cinnabarDeep)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                // Send-error uses CinnabarDeep tint on a soft fill; matches
                // the destructive accent everywhere else (cf. Remove buttons).
                .background(Capsule().fill(Color.amux.cinnabarDeep.opacity(0.10)))
                .overlay(Capsule().stroke(Color.amux.cinnabarDeep.opacity(0.20), lineWidth: 0.5))
                .padding(.vertical, 4)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if viewModel.events.isEmpty && viewModel.streamingAgentSet.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "bubble.left.and.bubble.right")
                                    .font(.system(size: 40))
                                    .foregroundStyle(.quaternary)
                                Text("No messages yet")
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 60)
                        }

                        ForEach(viewModel.feedItems) { item in
                            feedItemRow(item)
                                .id(item.id)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id("session-detail-bottom")
                    }
                    .padding(.top, 8)
                }
                .id(viewModel.hasLoadedInitialFeed)
                .opacity(isInitialFeedVisible ? 1 : 0)
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .task(id: viewModel.hasLoadedInitialFeed) {
                    guard viewModel.hasLoadedInitialFeed, !isInitialFeedVisible else { return }
                    initialAutoScrollSettled = false
                    await Task.yield()
                    proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                    await Task.yield()
                    isInitialFeedVisible = true
                    try? await Task.sleep(for: .milliseconds(1_200))
                    proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                    initialAutoScrollSettled = true
                }
                .task(id: initialFeedScrollKey) {
                    guard viewModel.hasLoadedInitialFeed, !initialAutoScrollSettled else { return }
                    await Task.yield()
                    proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                }
                // Store the proxy so the composer's onSend callback (inside
                // safeAreaInset, outside this ScrollViewReader scope) can
                // programmatically scroll to bottom after the user sends.
                .onAppear { scrollProxy = proxy }
                // Track whether the user is near the bottom so incoming
                // messages don't hijack the scroll position while they are
                // browsing history.
                .onScrollGeometryChange(for: Bool.self) { geo in
                    geo.contentSize.height - geo.contentOffset.y - geo.containerSize.height < nearBottomThreshold
                } action: { _, atBottom in
                    isAtBottom = atBottom
                }
                // Follow the bottom whenever the feed grows after the initial
                // settle. `.defaultScrollAnchor(.bottom, for: .initialOffset)`
                // only governs first paint, so without this the just-sent
                // message lands beneath the composer's safeAreaInset and the
                // user has to scroll manually to see it.
                .onChange(of: viewModel.feedItems.count) { oldCount, newCount in
                    guard initialAutoScrollSettled, newCount > oldCount, isAtBottom else { return }
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(AMUXAnimation.fast) {
                            proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                        }
                    }
                }
                // Any scroll on the chat surface dismisses the keyboard.
                // .interactively (iMessage-style finger-tracks-keyboard)
                // got swallowed by the composer's nested TextField scroll
                // and the SafeAreaInset hosting it; .immediately is more
                // robust and matches the user's expectation that pulling
                // the chat reveals more chat.
                .scrollDismissesKeyboard(.immediately)
            }
        }
        // Mist canvas — matches `agent-session.jsx`. Without an explicit
        // background, plain ScrollView falls back to systemBackground (stark
        // white), which breaks the seamless paper feel against the composer
        // and message bubbles.
        .background(Color.amux.mist)
        .navigationTitle(viewModel.sessionTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.amux.mist.opacity(0.85), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !viewModel.activePlanSnapshots.isEmpty {
                    Button {
                        withAnimation(AMUXAnimation.fast) {
                            isPlansPanelPresented.toggle()
                        }
                        persistPlansPanelState(isPlansPanelPresented)
                    } label: {
                        Image(systemName: "list.bullet.clipboard")
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                    .accessibilityLabel("Plans")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        isMemberSheetPresented = true
                    } label: {
                        Label("Members", systemImage: "person.2")
                    }
                    if notificationPrefsStore != nil || pushPrefs != nil {
                        Button {
                            Task {
                                let sessionID = viewModel.session?.sessionId ?? ""
                                if let store = notificationPrefsStore {
                                    await store.toggleMute(sessionID: sessionID)
                                    muted = store.isMuted(sessionID)
                                } else {
                                    let next = !muted
                                    muted = next
                                    try? await pushPrefs?.setSessionMuted(sessionID: sessionID, muted: next)
                                }
                            }
                        } label: {
                            Label(
                                muted ? "Unmute notifications" : "Mute notifications",
                                systemImage: muted ? "bell" : "bell.slash"
                            )
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session options")
                .task {
                    let sessionID = viewModel.session?.sessionId ?? ""
                    guard !sessionID.isEmpty else { return }
                    if let store = notificationPrefsStore {
                        muted = store.isMuted(sessionID)
                    } else if let api = pushPrefs {
                        muted = (try? await api.isSessionMuted(sessionID: sessionID)) ?? false
                    }
                }
            }
        }
        .onAppear {
            if let sid = viewModel.session?.sessionId {
                CurrentSessionFocus.sessionID = sid
            }
        }
        .onAppear {
            considerAutoOpeningPlans(count: viewModel.activePlanSnapshots.count)
        }
        .onChange(of: viewModel.activePlanSnapshots.count) { _, newCount in
            considerAutoOpeningPlans(count: newCount)
        }
        .onDisappear {
            if let sid = viewModel.session?.sessionId,
               CurrentSessionFocus.sessionID == sid {
                CurrentSessionFocus.sessionID = nil
            }
        }
        // Keep Plans as an overlay, not a top safe-area inset. Changing the
        // inset resizes ScrollView's viewport and makes the message list jump
        // when the toolbar button toggles the panel.
        .overlay(alignment: .top) {
            if isPlansPanelPresented {
                let snapshots = viewModel.activePlanSnapshots
                if !snapshots.isEmpty {
                    SessionPlansPanelView(
                        snapshots: snapshots,
                        pageIndex: $plansPageIndex
                    )
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                SessionComposer(
                    promptText: $promptText,
                    attachments: $attachments,
                    voiceRecorder: voiceRecorder,
                    availableCommands: viewModel.availableCommands,
                    availableMentions: mentionTargets(),
                    sessionID: viewModel.session?.sessionId ?? "",
                    teamID: viewModel.teamIDRef,
                    agentChips: viewModel.memberSheetAgents.map { a in
                        AgentChipBar.AgentChip(
                            id: a.id,
                            displayName: a.displayName,
                            runtimeState: AgentChipBar.RuntimeChipState.fromCore(a.runtimeState)
                        )
                    },
                    agentChipSelection: Binding(
                        get: { viewModel.agentChipSelection },
                        set: { viewModel.setAgentChipSelection($0) }
                    ),
                    streamingAgentIDs: viewModel.streamingAgentIDs,
                    onAgentInterrupt: { agentID in
                        viewModel.interruptAgent(agentID)
                    },
                    memberSheetAgents: viewModel.memberSheetAgents,
                    runtimeForAgent: viewModel.runtime(for:),
                    onApplyModelForAgent: { agent, modelID in
                        viewModel.setModel(forAgent: agent.id, model: modelID)
                    },
                    onSend: { attachmentURLs in
                        let text = promptText
                        let modelId = resolvedModelId
                        promptText = ""
                        attachments = []
                        // Snap to bottom when the user sends so the outbox
                        // message and the incoming reply are always visible,
                        // regardless of where they were scrolled to.
                        isAtBottom = true
                        withAnimation(AMUXAnimation.fast) {
                            scrollProxy?.scrollTo("session-detail-bottom", anchor: .bottom)
                        }
                        Task {
                            try? await viewModel.sendPrompt(text, modelId: modelId, attachmentURLs: attachmentURLs, modelContext: modelContext)
                        }
                    },
                    onAgentMention: { target in
                        viewModel.lightAgentChip(target.id)
                    }
                )
            }
        }
        .sheet(isPresented: $isMemberSheetPresented) {
            SessionMemberSheet(
                humans: viewModel.memberSheetHumans.map { h in
                    SessionMemberSheet.HumanRow(
                        id: h.id,
                        displayName: h.displayName,
                        isOnline: h.isOnline,
                        canRemove: h.canRemove
                    )
                },
                agents: viewModel.memberSheetAgents.map { row in
                    SessionMemberSheet.AgentRow(
                        id: row.id,
                        displayName: row.displayName,
                        workspacePath: row.workspacePath,
                        agentType: row.agentType,
                        runtimeState: AgentChipBar.RuntimeChipState.fromCore(row.runtimeState),
                        availableModels: row.availableModels,
                        currentModel: row.currentModel
                    )
                },
                onRemoveHuman: { viewModel.removeHuman($0) },
                onRestartRuntime: { viewModel.restartRuntime(forAgent: $0) },
                onChangeModel: { viewModel.setModel(forAgent: $0, model: $1) },
                onRemoveAgent: { viewModel.removeAgent($0) },
                onAddAgent: { isAddAgentSheetPresented = true },
                onAddMember: { isAddMemberSheetPresented = true }
            )
            .task { await viewModel.refreshMemberSheet() }
            .sheet(isPresented: $isAddAgentSheetPresented) {
                AddAgentSheet(
                    candidates: viewModel.candidatesForAddAgent(),
                    teamID: viewModel.teamIDRef,
                    workspacesRepository: workspacesRepository
                ) { actorID, workspaceID, workspacePath, agentType in
                    Task {
                        await viewModel.addAgent(
                            actorID: actorID,
                            workspaceID: workspaceID,
                            worktreePath: workspacePath,
                            agentType: agentType.asAmuxAgentType
                        )
                    }
                }
            }
            .sheet(isPresented: $isAddMemberSheetPresented) {
                AddMemberSheet(
                    excludedActorIDs: viewModel.existingParticipantActorIDs,
                    accessibleAgentIDs: Set(connectedAgentsStore?.agents.map(\.id) ?? []),
                    currentActorID: viewModel.currentHumanActorIDRef
                ) { humanActorIDs in
                    Task { await viewModel.addMembers(humanActorIDs) }
                }
            }
        }
        .sheet(item: $editingEvent) { event in
            EditMessageSheet(initialText: event.text ?? "") { newContent in
                guard let messageID = event.supabaseMessageId else { return }
                Task {
                    await viewModel.editUserMessage(
                        supabaseMessageID: messageID,
                        newContent: newContent
                    )
                }
            }
        }
        .confirmationDialog(
            "Delete this message?",
            isPresented: Binding(
                get: { pendingDeleteEvent != nil },
                set: { if !$0 { pendingDeleteEvent = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDeleteEvent
        ) { event in
            Button("Delete", role: .destructive) {
                guard let messageID = event.supabaseMessageId else { return }
                Task {
                    await viewModel.deleteUserMessage(supabaseMessageID: messageID)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The message is removed for everyone in this session.")
        }
        .task {
            // Build & start the outbox sender once the modelContext (and
            // its container) is available. Idempotent — `OutboxSender.start`
            // bails if a loop task is already running, so re-entry from
            // re-task does not spawn duplicates.
            if viewModel.outboxSender == nil, let svc = pendingTeamclawService {
                let sender = OutboxSender(
                    teamclaw: svc,
                    modelContainer: modelContext.container
                )
                viewModel.outboxSender = sender
            }
            await viewModel.outboxSender?.start()
            viewModel.start(modelContext: modelContext)
            await viewModel.refreshMemberSheet()
        }
        .onChange(of: viewModel.runtime?.status) { _, _ in
            // Bound-runtime lifecycle just transitioned (spawning →
            // running → idle / stopped / etc.). Re-pull agent_runtimes
            // so the member-sheet row dot color tracks reality. The
            // status string lives on Supabase and is one-shot fetched,
            // so without this onChange the snapshot goes stale.
            Task { await viewModel.refreshMemberSheet() }
        }
        .onChange(of: viewModel.isStreaming) { _, newValue in
            // First ACP event arrived — the runtime is definitely up
            // even if the SwiftData Runtime entity's status field hasn't
            // propagated through @Observable yet (a known limitation
            // when SwiftData mutations don't re-evaluate computed nested
            // optionals). Refresh so the chip flips spawning → active
            // and the member sheet row's "loading" turns into the
            // current model picker.
            if newValue {
                Task { await viewModel.refreshMemberSheet() }
            }
        }
        .onChange(of: viewModel.isActive) { _, newValue in
            // isActive covers thinking + tool_use windows ahead of any
            // raw text output. Refresh on the rising edge too so the
            // chip's stop icon appears as soon as the agent starts
            // working, not only when text begins streaming.
            if newValue {
                Task { await viewModel.refreshMemberSheet() }
            }
        }
        .onChange(of: viewModel.isAgentWorking) { _, newValue in
            if newValue {
                Task { await viewModel.refreshMemberSheet() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // The streaming buffer lives in `streamingTextByAgent`,
            // which is in-memory only. If iOS reclaims the suspended
            // process, that partial text vanishes — and on cold relaunch
            // the resume path has nothing to hydrate from. Snapshot it
            // to SwiftData on background so the cold-launch hydrate
            // picks it up; on the common case where the process
            // survives, the foreground hook deletes the snapshot so it
            // doesn't double-render alongside the still-live buffer.
            // MQTT reconnect is owned by `ContentView`'s own scenePhase
            // observer.
            switch phase {
            case .background:
                viewModel.flushStreamingForBackground()
            case .active:
                viewModel.discardBackgroundSnapshot()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
        .onDisappear {
            // Do NOT call viewModel.stop() here. SwiftUI fires this hook
            // both when this view is being popped out of the nav stack
            // (true exit) AND when a destination is pushed on top of it
            // (we're still in the back-stack). The two are indistinguishable
            // at this hook, but the cost of treating "push" as "exit" is
            // brutal: cancelling the MQTT task drops every ACP envelope
            // that arrives while StreamingDetailView (or any destination)
            // is on top, so the live-stream view freezes on whatever
            // events it had at push time and the bubbles only appear after
            // popping back triggers incremental sync replay.
            //
            // Lifetime is now owned by the VM itself: its `deinit`
            // cancels the task, which fires when the owning view (the
            // ancestor that holds the VM via @State / @Bindable) drops
            // its last reference. The task captures `self` weakly so
            // the retain cycle that would otherwise prevent deinit is
            // broken.
        }
    }

    private var resolvedModelId: String? {
        // Per-agent model selection is owned by AgentsSheet via
        // viewModel.setModel(forAgent:model:), so there's no longer a
        // session-level override stored on the view. Fall back to the bound
        // primary runtime's current model for the legacy single-agent path.
        guard let current = viewModel.runtime?.currentModel, !current.isEmpty else { return nil }
        return current
    }

    private var initialFeedScrollKey: String {
        "\(viewModel.hasLoadedInitialFeed)-\(viewModel.feedItems.count)-\(viewModel.feedItems.last?.id ?? "none")"
    }

    private func considerAutoOpeningPlans(count: Int) {
        if count > 0 && !hasAutoOpenedPlans {
            hasAutoOpenedPlans = true
            if let saved = savedPlansPanelState() {
                withAnimation(AMUXAnimation.fast) {
                    isPlansPanelPresented = saved
                }
            } else {
                withAnimation(AMUXAnimation.fast) {
                    isPlansPanelPresented = true
                }
            }
        }
        if count == 0 && isPlansPanelPresented {
            withAnimation(AMUXAnimation.fast) {
                isPlansPanelPresented = false
            }
        }
    }

    private func plansPanelDefaultsKey() -> String? {
        guard let sid = viewModel.session?.sessionId, !sid.isEmpty else { return nil }
        return "session.plansPanelOpen.\(sid)"
    }

    private func savedPlansPanelState() -> Bool? {
        guard let key = plansPanelDefaultsKey(),
              UserDefaults.standard.object(forKey: key) != nil else { return nil }
        return UserDefaults.standard.bool(forKey: key)
    }

    private func persistPlansPanelState(_ open: Bool) {
        guard let key = plansPanelDefaultsKey() else { return }
        UserDefaults.standard.set(open, forKey: key)
    }

    /// Resolve an agent actor id to a member-sheet display name. Falls
    /// back to a truncated id so an unmapped sender still has a label.
    private func agentDisplayName(for agentID: String) -> String {
        viewModel.memberSheetAgents.first(where: { $0.id == agentID })?.displayName
            ?? String(agentID.prefix(8))
    }

    /// Pick the best single-line summary for the active-stream card.
    /// Priority: live streaming text → most recent thinking/output text
    /// → most recent tool name → "Working…". The card truncates further
    /// at the view layer.
    private func activeStreamLastLine(agentID: String, runtimeEvents: [AgentEvent]) -> String {
        let live = viewModel.streamingTextByAgent[agentID] ?? ""
        if !live.isEmpty {
            // The card is lineLimit(1). Operate on the buffer tail so a
            // 50KB reply doesn't get copied and newline-replaced in full
            // on every token — the visible output is identical.
            return live.suffix(240).replacingOccurrences(of: "\n", with: " ")
        }
        if let last = runtimeEvents.reversed().first(where: { e in
            (e.eventType == "output" || e.eventType == "thinking") && !(e.text ?? "").isEmpty
        }) {
            return (last.text ?? "").suffix(240).replacingOccurrences(of: "\n", with: " ")
        }
        if let lastTool = runtimeEvents.reversed().first(where: { $0.eventType == "tool_use" }) {
            return lastTool.toolName.map { "Running \($0)…" } ?? "Working…"
        }
        return "Working…"
    }

    @ViewBuilder
    private func feedItemRow(_ item: FeedItem) -> some View {
        switch item {
        case .userMessage(let event), .permission(let event), .todo(let event), .error(let event):
            EventBubbleView(
                event: event,
                runtime: viewModel.runtime,
                onGrant: { id, agentID in Task { try? await viewModel.grantPermission(requestId: id, agentActorID: agentID) } },
                onDeny: { id, agentID in Task { try? await viewModel.denyPermission(requestId: id, agentActorID: agentID) } },
                onRetryOutbox: { msgID in
                    if let sender = viewModel.outboxSender {
                        Task { await sender.retry(messageID: msgID) }
                    }
                },
                actorMap: cachedActorMap,
                onEdit: canModifyMessage(event) ? { editingEvent = event } : nil,
                onDelete: canModifyMessage(event) ? { pendingDeleteEvent = event } : nil
            )
        case .activeStream(_, let agentID, let runtimeEvents):
            // NavigationLink(destination:) instead of value-based push
            // because the parent NavigationStack uses a `[String]`-typed
            // path (SessionsTab / IdeasTab) — value-based pushes of
            // `TurnRoute` would be silently dropped by SwiftUI when the
            // type doesn't match the path's element type.
            //
            // `isPending` is true between send-tap and the first ACP
            // delta/event arrival. In that window the card is surfaced
            // by `markAgentWorking()` priming `streamingAgentSet` —
            // there are no runtime events and no live text buffer yet,
            // so we render the cinnabar breathing light + "Agent
            // loading…". The first delta both populates `runtimeEvents`
            // /`streamingTextByAgent` and flips `isPending` false, at
            // which point the dot transitions to sage and the label
            // switches to the live last-line preview.
            let liveText = viewModel.streamingTextByAgent[agentID] ?? ""
            let isPending = runtimeEvents.isEmpty && liveText.isEmpty
            NavigationLink(
                destination: StreamingDetailView(
                    route: TurnRoute(agentID: agentID, frozenTurnID: nil),
                    viewModel: viewModel
                )
            ) {
                ActiveStreamCardView(
                    agentName: agentDisplayName(for: agentID),
                    lastLine: activeStreamLastLine(agentID: agentID, runtimeEvents: runtimeEvents),
                    isPending: isPending
                )
            }
            .buttonStyle(.plain)
        case .completedTurn(let id, let agentID, let final, _):
            CompletedTurnBubbleView(
                finalEvent: final,
                runtime: viewModel.runtime,
                agentName: agentDisplayName(for: agentID),
                detailIcon: {
                    // Always offer the detail entry point — even text-only
                    // turns benefit from giving the user access to the
                    // turn's daemon-recorded trace (model, timing, future
                    // tool calls if requestTurnHistory finds them).
                    //
                    // Pebble-filled capsule with cinnabar label so the
                    // affordance reads as a button rather than decoration.
                    // Previous 13pt secondary glyph was easy to miss; the
                    // bubble shows only the final reply text now, so the
                    // turn's thinking + tool calls only surface here.
                    NavigationLink(
                        destination: StreamingDetailView(
                            route: TurnRoute(agentID: agentID, frozenTurnID: id),
                            viewModel: viewModel
                        )
                    ) {
                        HStack(spacing: 3) {
                            Image(systemName: "list.bullet.indent")
                                .font(.system(size: 10, weight: .semibold))
                            Text("过程")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .foregroundStyle(Color.amux.cinnabar)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(Color.amux.pebble.opacity(0.85))
                                .overlay(
                                    Capsule().stroke(Color.amux.hairline, lineWidth: 0.5)
                                )
                        )
                        .padding(6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("查看过程")
                }
            )
        }
    }

    /// Edit/delete are offered only for the signed-in user's own prompts
    /// that have already landed in the backend — `supabaseMessageId` is the
    /// PATCH/DELETE routing key, so a still-in-outbox bubble (nil id) has
    /// nothing to mutate remotely yet. Agent replies and system rows never
    /// qualify (eventType gate).
    private func canModifyMessage(_ event: AgentEvent) -> Bool {
        guard event.eventType == "user_prompt",
              event.supabaseMessageId != nil,
              let sender = event.senderActorID, !sender.isEmpty,
              let me = viewModel.currentHumanActorIDRef, !me.isEmpty
        else { return false }
        return sender == me
    }

    private func mentionTargets() -> [MentionTarget] {
        let members = viewModel.memberSheetHumans.map { h in
            MentionTarget(id: h.id, displayName: h.displayName, subtitle: "Member", kind: .member)
        }
        let agents = viewModel.memberSheetAgents.map { a in
            // Subtitle shows the agent type only — the lifecycle state is
            // sourced from the agent_runtimes snapshot which is fetched
            // once on sheet open and goes stale fast (e.g. shows "spawning"
            // long after spawn). The chip bar above the composer carries
            // the live state via MQTT-pushed Runtime entities.
            MentionTarget(id: a.id, displayName: a.displayName, subtitle: a.agentType, kind: .agent)
        }
        return agents + members
    }
}

// MARK: - EditMessageSheet
//
// Minimal Hai editor for rewriting an own prompt: mist canvas, a single
// paper card holding the TextEditor, Cancel/Save in the nav bar. Save is
// disabled while the draft trims to empty so the PATCH can never blank a
// message out.

private struct EditMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    private let onSave: (String) -> Void

    init(initialText: String, onSave: @escaping (String) -> Void) {
        _draft = State(initialValue: initialText)
        self.onSave = onSave
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextEditor(text: $draft)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.onyx)
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .frame(maxWidth: .infinity, minHeight: 160, maxHeight: .infinity, alignment: .topLeading)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.amux.paper)
                    )
                    .padding(16)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color.amux.mist)
            .navigationTitle("Edit Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(trimmedDraft)
                        dismiss()
                    }
                    .disabled(trimmedDraft.isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - AgentChipBar.RuntimeChipState translation

extension AgentChipBar.RuntimeChipState {
    static func fromCore(_ s: AgentRuntimeChipState) -> AgentChipBar.RuntimeChipState {
        switch s {
        case .spawning: .spawning
        case .ready: .ready
        case .idle: .idle
        case .active: .active
        case .stopped: .stopped
        case .error: .error
        }
    }
}
