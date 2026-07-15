import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

#if os(iOS)

// MARK: - SessionListContent

struct SessionListContent: View {
    @Bindable var viewModel: SessionListViewModel
    let refreshSessionsFromBackend: () async -> Void
    @Binding var navigationPath: [String]
    @Binding var isEditing: Bool
    @Binding var selectedIDs: Set<String>
    let teamclawService: TeamclawService?
    let pairing: PairingManager
    let mqtt: MQTTService
    let actorId: String
    /// Signed-in user's actor id (Supabase `actors.id`). Drives the "you = Cinnabar"
    /// chip in the participant cluster. Distinct from `actorId` above, which
    /// is the daemon peer id derived from the pairing token.
    let currentActorID: String?
    /// True when the current user has zero accessible agents in this team.
    /// The empty-state copy switches to an invite-first-agent CTA in that case.
    let noAccessibleAgent: Bool
    /// Tap handler for the empty-state CTA. Caller presents an invite sheet.
    /// Pass nil to hide the action (e.g. when no ActorStore is available yet).
    let onInviteFirstAgent: (() -> Void)?
    /// Per-session mute state + toggle. Nil hides the mute affordances
    /// (e.g. before the team runtime is built).
    let notificationPrefsStore: NotificationPrefsStore?
    /// Backs the "Mark as unread" swipe action. Nil hides the action —
    /// without the server rewind the next unread reconcile would clear the
    /// local flag again, so a purely-local flip would just flicker.
    let sessionsListRepository: (any SessionsRepository)?

    @Environment(\.modelContext) private var modelContext

    /// Locally-cached team directory keyed by actor id. Drives initials,
    /// display name, and agent-vs-human shaping for the participant cluster.
    @Query private var allActors: [CachedActor]

    /// Most-recent cached messages across all sessions. Capped — we only
    /// need to discover distinct senders per session for the participant
    /// cluster, not replay threads, and the messages table grows without
    /// bound as history accumulates.
    @Query(SessionListContent.recentMessagesDescriptor)
    private var recentMessages: [SessionMessage]

    private static var recentMessagesDescriptor: FetchDescriptor<SessionMessage> {
        var descriptor = FetchDescriptor<SessionMessage>(
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        descriptor.fetchLimit = 500
        return descriptor
    }

    private var flatSessions: [Session] {
        viewModel.groupedSessions.flatMap(\.items)
    }

    private var actorByID: [String: CachedActor] {
        Dictionary(allActors.map { ($0.actorId, $0) }, uniquingKeysWith: { a, _ in a })
    }

    /// Distinct senderActorIds per session, ordered by most-recent message
    /// first. Built once per body evaluation so each row gets a synchronous
    /// lookup instead of a per-row SwiftData fetch.
    private var sendersBySession: [String: [String]] {
        var ordered: [String: [String]] = [:]
        var seen: [String: Set<String>] = [:]
        for msg in recentMessages {
            let sid = msg.sessionId
            let aid = msg.senderActorId
            if sid.isEmpty || aid.isEmpty { continue }
            if seen[sid, default: []].contains(aid) { continue }
            seen[sid, default: []].insert(aid)
            ordered[sid, default: []].append(aid)
        }
        return ordered
    }

    private func participantPreviews(for session: Session) -> [ParticipantPreview] {
        let directory = actorByID
        let senders = sendersBySession[session.sessionId] ?? []

        var ids: [String] = []
        var seen = Set<String>()
        func add(_ id: String?) {
            guard let id, !id.isEmpty, !seen.contains(id) else { return }
            ids.append(id); seen.insert(id)
        }

        // Order: current user first (so the "YT" chip leads the stack),
        // then the primary agent, then anyone else who has spoken. Falls
        // through to session.createdBy when the user hasn't sent a message
        // yet — covers freshly-created sessions before any reply arrives.
        if let me = currentActorID { add(me) }
        add(session.primaryAgentId)
        if !session.createdBy.isEmpty { add(session.createdBy) }
        for sender in senders { add(sender) }

        return ids.prefix(ParticipantCluster.maxVisible).map { id in
            let actor = directory[id]
            return ParticipantPreview(
                actorID: id,
                displayName: actor?.displayName ?? "",
                isAgent: actor?.isAgent ?? false,
                isCurrentUser: id == currentActorID,
                defaultAgentType: actor?.defaultAgentType
            )
        }
    }
    private var hasContent: Bool { !flatSessions.isEmpty }
    private var hasActiveSearch: Bool {
        !viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        // Single List for everything so the daemon banner + search field
        // scroll out of view alongside the session rows, freeing vertical
        // real estate on long lists. The header lives as a normal, non-
        // sticky row at the top; loading / empty states sit in their own
        // borderless row beneath it.
        List {
            headerRow

            if !hasContent && viewModel.isLoading {
                loadingRow
            } else if !hasContent {
                emptyRow
            } else {
                // Plain flat list — day grouping retired per
                // sessions-list.jsx, which uses only hairline separators
                // inset under the title (handled by AgentRowView's
                // alignmentGuide(.listRowSeparatorLeading)).
                ForEach(flatSessions, id: \.sessionId) { session in
                    sessionRow(session)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.amux.mist)
        .refreshable {
            await refreshSessionsFromBackend()
        }
    }

    @ViewBuilder
    private var headerRow: some View {
        VStack(spacing: 8) {
            DaemonStatusBanner(pairing: pairing, mqtt: mqtt)
            SessionListSearchField(text: $viewModel.searchText)
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
    }

    @ViewBuilder
    private var loadingRow: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading sessions…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private var emptyRow: some View {
        Group {
            if hasActiveSearch {
                ContentUnavailableView.search(text: viewModel.searchText)
            } else if noAccessibleAgent {
                ContentUnavailableView {
                    Label("Invite your first agent", systemImage: "cpu")
                } description: {
                    Text("You don't have access to any agent in this team yet. Invite one to start a session.")
                } actions: {
                    Button {
                        onInviteFirstAgent?()
                    } label: {
                        Text("Invite agent")
                            .fontWeight(.semibold)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                    }
                    .glassProminentButtonStyle()
                    .accessibilityIdentifier("sessions.inviteFirstAgentButton")
                }
            } else {
                ContentUnavailableView("No Sessions", systemImage: "cpu",
                    description: Text("Start a new session to begin"))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 280)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func sessionRow(_ session: Session) -> some View {
        let cached = cachedAgentRuntime(for: session)
        let runtime = liveRuntime(for: cached)
        HStack(spacing: 10) {
            if isEditing {
                Image(systemName: selectedIDs.contains(session.sessionId) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedIDs.contains(session.sessionId) ? .blue : .secondary)
                    .font(.title3)
                    .onTapGesture { toggleSelection(session.sessionId) }
            }
            AgentRowView(
                session: session,
                runtime: runtime,
                cachedRuntime: cached,
                workspaceName: workspaceName(runtime: runtime, cached: cached),
                participants: participantPreviews(for: session),
                isMuted: notificationPrefsStore?.isMuted(session.sessionId) ?? false
            )
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if isEditing {
                toggleSelection(session.sessionId)
            } else {
                if let runtimeId = runtime?.runtimeId {
                    viewModel.markAsRead(runtimeId: runtimeId)
                }
                navigationPath.append("session:\(session.sessionId)")
            }
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        // Plain-list rows default to systemBackground (stark white) which
        // breaks the seamless-on-Mist treatment from sessions-list.jsx. Clear
        // the per-row fill and pin the hairline separator to the Hai token so
        // the only visible structure is the subtle inset rule under the title.
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Color.amux.hairline)
        .contextMenu {
            if let store = notificationPrefsStore {
                let isMuted = store.isMuted(session.sessionId)
                Button {
                    Task { await store.toggleMute(sessionID: session.sessionId) }
                } label: {
                    Label(isMuted ? "Unmute notifications" : "Mute notifications",
                          systemImage: isMuted ? "bell" : "bell.slash")
                }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                session.isArchived = true
                try? modelContext.save()
            } label: {
                Label("Archive", systemImage: "archivebox.fill")
            }
            .tint(Color.amux.cinnabarDeep)

            Button {
                session.isPinned.toggle()
                try? modelContext.save()
            } label: {
                Label(session.isPinned ? "Unpin" : "Pin",
                      systemImage: session.isPinned ? "pin.slash.fill" : "pin.fill")
            }
            .tint(Color.amux.basalt)
        }
        // Leading swipe = read-state, mirroring Mail/iMessage muscle memory.
        // Only offered while the session reads as "read" — flipping an
        // already-unread row would be a no-op that just hides the dot's
        // provenance. Opening the session still clears it via the existing
        // mark-viewed path in SessionDetailViewModel.start().
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if sessionsListRepository != nil && !session.hasUnread {
                Button {
                    Task {
                        await viewModel.markSessionUnread(
                            sessionId: session.sessionId,
                            sessionsRepo: sessionsListRepository,
                            modelContext: modelContext
                        )
                    }
                } label: {
                    Label("Mark as unread", systemImage: "envelope.badge")
                }
                .tint(Color.amux.cinnabar)
            }
        }
    }

    /// Most-recently-updated `agent_runtimes` row that serves this session.
    /// Provides backend type + workspace + status when MQTT is offline.
    private func cachedAgentRuntime(for session: Session) -> CachedAgentRuntime? {
        viewModel.cachedAgentRuntimes
            .filter { $0.sessionId == session.sessionId }
            .max(by: { $0.updatedAt < $1.updatedAt })
    }

    /// Bridge from a Supabase `agent_runtimes` row to its MQTT-published
    /// `Runtime` snapshot via `runtime_id` (the daemon's 8-char id, distinct
    /// from `backend_session_id`'s 36-char ACP session id). Nil when the
    /// daemon is offline or hasn't published yet.
    private func liveRuntime(for cached: CachedAgentRuntime?) -> Runtime? {
        guard let bridge = cached?.runtimeId, !bridge.isEmpty else { return nil }
        return viewModel.runtimes.first(where: { $0.runtimeId == bridge })
    }

    private func workspaceName(runtime: Runtime?, cached: CachedAgentRuntime?) -> String {
        guard let id = cached?.workspaceId, !id.isEmpty else { return "" }
        return viewModel.workspaces.first(where: { $0.workspaceId == id })?.displayName ?? ""
    }

    private func toggleSelection(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) }
        else { selectedIDs.insert(id) }
    }
}

// MARK: - AgentRowView

struct AgentRowView: View {
    let session: Session
    let runtime: Runtime?
    let cachedRuntime: CachedAgentRuntime?
    let workspaceName: String
    let participants: [ParticipantPreview]
    let isMuted: Bool

    init(
        session: Session,
        runtime: Runtime? = nil,
        cachedRuntime: CachedAgentRuntime? = nil,
        workspaceName: String = "",
        participants: [ParticipantPreview] = [],
        isMuted: Bool = false
    ) {
        self.session = session
        self.runtime = runtime
        self.cachedRuntime = cachedRuntime
        self.workspaceName = workspaceName
        self.participants = participants
        self.isMuted = isMuted
    }

    private var displayTitle: String {
        session.title.isEmpty ? "Untitled Session" : session.title
    }

    private var lastMessage: String { session.lastMessagePreview }
    // Two distinct unread signals:
    //   - runtime.hasUnread: this client noticed new agent output it hasn't shown
    //   - session.hasUnread: server says a peer's message arrived since last view
    //                         (computed by list_current_actor_sessions from
    //                          session_read_markers + sessions.last_message_at)
    // Either is sufficient to surface a red dot.
    private var isUnread: Bool { (runtime?.hasUnread ?? false) || session.hasUnread }

    private var isRunning: Bool {
        if let runtime { return runtime.status == 2 }
        return cachedRuntime?.status == "running"
    }
    private var isStarting: Bool {
        if let runtime { return runtime.status == 1 }
        return cachedRuntime?.status == "starting"
    }
    private var isStopped: Bool {
        if let runtime { return runtime.status == 5 }
        return cachedRuntime?.status == "stopped" || cachedRuntime?.status == "failed"
    }

    private var statusLabel: String {
        if let runtime, runtime.status != 0 { return runtime.statusLabel }
        if let raw = cachedRuntime?.status, !raw.isEmpty {
            return raw.prefix(1).uppercased() + raw.dropFirst()
        }
        return ""
    }

    private var statusForeground: Color {
        if isRunning  { return Color.amux.sage }
        if isStarting { return Color.amux.basalt }
        return Color.amux.basalt
    }

    private var statusDotColor: Color {
        if isRunning  { return Color.amux.sage }
        if isStarting { return Color.amux.slate }
        if isStopped  { return Color.amux.onyx.opacity(0.25) }
        return Color.amux.slate
    }

    /// Pebble-tinted badge with a backend-keyed foreground. Per the Hai
    /// principle of "spare the vermillion", only the Claude variant gets
    /// Cinnabar; OpenCode/Codex sit in Basalt. Stopped sessions drop to
    /// Slate. Background is always Pebble — the brand-color rainbow from
    /// earlier rounds has been retired.
    private struct AgentBadge {
        let background: Color
        let foreground: Color
        let glyph: String
    }

    private var agentBadge: AgentBadge {
        let bg = Color.amux.pebble
        switch cachedRuntime?.backendType {
        case "claude":
            return AgentBadge(background: bg, foreground: Color.amux.cinnabar, glyph: "CC")
        case "opencode":
            return AgentBadge(background: bg, foreground: Color.amux.basalt, glyph: "OC")
        case "codex":
            return AgentBadge(background: bg, foreground: Color.amux.basalt, glyph: "CX")
        default:
            return AgentBadge(background: bg, foreground: Color.amux.slate, glyph: fallbackGlyph)
        }
    }

    private var fallbackGlyph: String {
        let source = session.title.isEmpty ? session.sessionId : session.title
        let last = source.split(separator: "/").last.map(String.init) ?? source
        return last.isEmpty ? "·" : String(last.prefix(1)).uppercased()
    }

    private var rowTimestamp: Date {
        session.lastMessageAt ?? session.createdAt
    }

    private func formatTime(_ date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 60     { return "now" }
        if seconds < 3600   { return "\(seconds / 60)m" }
        if seconds < 86400  { return "\(seconds / 3600)h" }
        if seconds < 604800 { return "\(seconds / 86400)d" }
        let f = DateFormatter()
        f.dateFormat = "MM/dd"
        return f.string(from: date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                badgeView
                Text(displayTitle)
                    .font(.body)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .foregroundStyle(isStopped ? Color.amux.basalt : Color.amux.onyx)
                Spacer(minLength: 4)
                // Quiet muted marker — bare Slate glyph, no capsule, per the
                // Hai restraint rules (status whispers, never shouts).
                if isMuted {
                    Image(systemName: "bell.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.amux.slate)
                        .accessibilityLabel("Muted")
                }
                if isUnread {
                    Circle()
                        .fill(Color.amux.cinnabar)
                        .frame(width: 7, height: 7)
                }
                Text(formatTime(rowTimestamp))
                    .font(.caption)
                    .foregroundStyle(Color.amux.slate)
            }

            if !lastMessage.isEmpty {
                Text(lastMessage)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.basalt)
                    .lineLimit(1)
                    .padding(.leading, badgeIndent)
            }

            metaStrip
                .padding(.leading, badgeIndent)
        }
        .padding(.vertical, 6)
        .alignmentGuide(.listRowSeparatorLeading) { _ in Self.badgeIndent }
    }

    private static let badgeIndent: CGFloat = 38
    private var badgeIndent: CGFloat { Self.badgeIndent }

    private var badgeView: some View {
        let badge = agentBadge
        return HStack(spacing: 5) {
            Circle()
                .fill(statusDotColor)
                .frame(width: 5, height: 5)
                .breathingOpacity(active: isRunning)
            Text(badge.glyph)
                .font(.system(size: 11, weight: .bold))
                .tracking(0.2)
                .foregroundStyle(badge.foreground)
        }
        .padding(.horizontal, 7)
        .frame(height: 22)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(badge.background)
        )
    }

    @ViewBuilder
    private var metaStrip: some View {
        HStack(spacing: 8) {
            if !workspaceName.isEmpty {
                Text(workspaceName)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.amux.slate)
                    .lineLimit(1)
            }

            if !workspaceName.isEmpty && !statusLabel.isEmpty {
                Circle()
                    .fill(Color.amux.slate.opacity(0.5))
                    .frame(width: 3, height: 3)
            }

            if !statusLabel.isEmpty {
                Text(statusLabel)
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(statusForeground)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            // Right-side participant cluster — `sessions-list.jsx →
            // ParticipantStack`. Source data is stitched together from
            // local SwiftData caches (current user, primary agent, session
            // creator, then anyone who has sent a message) by
            // SessionListContent.participantPreviews; we never round-trip
            // to Supabase for this read.
            if !participants.isEmpty {
                ParticipantCluster(participants: participants)
            }
        }
    }
}

// MARK: - Transition Modifiers

struct ZoomTransitionModifier: ViewModifier {
    let sourceID: String
    let namespace: Namespace.ID
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.navigationTransition(.zoom(sourceID: sourceID, in: namespace))
        } else { content }
    }
}

struct MatchedTransitionSourceModifier: ViewModifier {
    let sourceID: String
    let namespace: Namespace.ID
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.matchedTransitionSource(id: sourceID, in: namespace)
        } else { content }
    }
}

#endif
