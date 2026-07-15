import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

#if os(iOS)

public struct MemberListContent: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \CachedActor.displayName) private var actors: [CachedActor]
    @State private var searchText = ""
    @State private var kindFilter: ActorKindFilter = .all

    enum ActorKindFilter: Hashable {
        case all, humans, agents
    }

    let store: ActorStore
    let pairing: PairingManager
    let mqtt: MQTTService
    let sessionViewModel: SessionListViewModel
    let teamclawService: TeamclawService?
    /// Actor id of the signed-in user. Drives the "YOU" badge on their row.
    /// `nil` hides the badge.
    let currentActorID: String?
    /// Source of truth for the "current user has no accessible agent" notice.
    /// `nil` keeps the notice hidden (e.g. before the team is configured).
    let connectedAgentsStore: ConnectedAgentsStore?
    /// Invoked when the user taps the inline notice's CTA. Parent surfaces
    /// the existing MemberInviteSheet (Agent kind preset).
    let onAddYourAgent: (() -> Void)?

    public init(
        store: ActorStore,
        pairing: PairingManager,
        mqtt: MQTTService,
        sessionViewModel: SessionListViewModel,
        teamclawService: TeamclawService?,
        currentActorID: String? = nil,
        connectedAgentsStore: ConnectedAgentsStore? = nil,
        onAddYourAgent: (() -> Void)? = nil
    ) {
        self.store = store
        self.pairing = pairing
        self.mqtt = mqtt
        self.sessionViewModel = sessionViewModel
        self.teamclawService = teamclawService
        self.currentActorID = currentActorID
        self.connectedAgentsStore = connectedAgentsStore
        self.onAddYourAgent = onAddYourAgent
    }

    /// True when the current user has zero accessible agents in this team.
    /// Distinct from "team has zero agents" — handled separately by the
    /// RootTabView reminder sheet.
    private var showOwnAgentNotice: Bool {
        guard let store = connectedAgentsStore else { return false }
        return !store.isLoading && store.agents.isEmpty
    }

    private var filtered: [CachedActor] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return actors }
        let norm = q.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        return actors.filter { a in
            [a.displayName, a.roleLabel, a.defaultAgentType ?? "", a.actorId]
                .joined(separator: " ")
                .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
                .contains(norm)
        }
    }

    private var humans: [CachedActor] { filtered.filter(\.isMember) }
    private var agents: [CachedActor] { filtered.filter(\.isAgent) }

    private var kindFilteredHumans: [CachedActor] {
        kindFilter == .agents ? [] : humans
    }

    private var kindFilteredAgents: [CachedActor] {
        kindFilter == .humans ? [] : agents
    }

    private var kindSegments: [SegmentedFilterBar<ActorKindFilter>.Segment] {
        // "All" deliberately counts only `humans + agents` (what the row
        // sections actually render). `filtered.count` also picks up
        // gateway-only `actor_type='external'` rows (e.g. a WeCom bridge
        // actor) which today land in neither section — using it for the
        // pill would print "All · 4" alongside "Humans · 3 / Agents · 0",
        // a phantom row the user can never see.
        [
            .init(tag: .all,    title: "All",    count: humans.count + agents.count),
            .init(tag: .humans, title: "Humans", count: humans.count),
            .init(tag: .agents, title: "Agents", count: agents.count),
        ]
    }

    public var body: some View {
        Group {
            if actors.isEmpty {
                ContentUnavailableView("No Actors Yet", systemImage: "person.2",
                                       description: Text("Invite teammates or agents to see them here."))
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else {
                List {
                    Section {
                        SegmentedFilterBar(segments: kindSegments, selection: $kindFilter)
                            .padding(.horizontal, 16)
                            .padding(.top, 4)
                            .padding(.bottom, 12)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets())
                    }

                    if showOwnAgentNotice {
                        Section {
                            ownAgentNotice
                                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                        }
                    }
                    if !kindFilteredHumans.isEmpty {
                        Section {
                            ForEach(kindFilteredHumans, id: \.actorId, content: detailLink)
                        } header: {
                            sectionHeader(title: "Humans", count: kindFilteredHumans.count)
                        }
                    }
                    if !kindFilteredAgents.isEmpty {
                        Section {
                            ForEach(kindFilteredAgents, id: \.actorId, content: detailLink)
                        } header: {
                            sectionHeader(title: "Agent actors", count: kindFilteredAgents.count)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Color.amux.mist)
        .searchable(text: $searchText, prompt: "Search actors")
        .task { await store.reload(); await store.heartbeat() }
        .refreshable { await store.reload() }
    }

    @ViewBuilder
    private func detailLink(_ a: CachedActor) -> some View {
        NavigationLink(value: a.actorId) {
            ActorRow(actor: a, isMe: a.actorId == currentActorID)
        }
        // Plain-list rows would otherwise pick up systemBackground (white)
        // and a default-tinted separator. Clear the fill so Mist shows
        // through and pin the hairline to the Hai token.
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Color.amux.hairline)
    }

    private func sectionHeader(title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .tracking(0.4)
                .foregroundStyle(Color.amux.slate)
            Text("·")
                .foregroundStyle(Color.amux.slate.opacity(0.7))
            Text("\(count)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(Color.amux.slate)
                .monospacedDigit()
        }
        .font(.caption)
        .fontWeight(.semibold)
        .textCase(nil)
    }

    private var ownAgentNotice: some View {
        Button {
            onAddYourAgent?()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "lightbulb")
                    .font(.footnote)
                    .foregroundStyle(Color.amux.cinnabar)
                Text("Add your own agent")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.amux.onyx)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(Color.amux.slate)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.amux.cinnabar.opacity(0.10))
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("members.addYourAgentNotice")
    }
}

private struct ActorRow: View {
    let actor: CachedActor
    var isMe: Bool = false

    private var avatarInitials: String {
        let parts = actor.displayName
            .split(whereSeparator: { $0.isWhitespace || $0 == "·" })
            .prefix(2)
        let initials = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        if !initials.isEmpty { return initials }
        return String(actor.displayName.prefix(1)).uppercased()
    }

    /// Hai avatar style — per `actors-list.jsx`:
    /// - You → solid Cinnabar fill with white glyph (the one place "YT"
    ///   earns the vermillion seal).
    /// - Other humans → solid hash-rotated fill from Basalt / Slate / Sage
    ///   with white glyph.
    /// - Agents → Pebble bg with agent-color glyph (Claude = Cinnabar,
    ///   OpenCode = Sage, Codex = Basalt).
    /// Tile shape (rounded square vs circle) is still the secondary cue
    /// for agent vs human.
    private struct AvatarStyle {
        let background: Color
        let foreground: Color
    }

    private var avatarStyle: AvatarStyle {
        if actor.isAgent {
            let fg: Color
            switch actor.defaultAgentType {
            case "claude", "claude_code": fg = Color.amux.cinnabar
            case "opencode":    fg = Color.amux.sage
            case "codex":       fg = Color.amux.basalt
            default:            fg = Color.amux.basalt
            }
            return AvatarStyle(background: Color.amux.pebble, foreground: fg)
        }
        if isMe {
            return AvatarStyle(background: Color.amux.cinnabar, foreground: .white)
        }
        let palette: [Color] = [
            Color.amux.basalt,
            Color.amux.slate,
            Color.amux.sage,
            Color.amux.onyx,
        ]
        let hash = actor.actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return AvatarStyle(background: palette[abs(hash) % palette.count],
                           foreground: .white)
    }

    /// Subtitle copy targets `actors-list.jsx`: humans get an identifier
    /// line (mono "you · ios-<short>" for the signed-in user, role label
    /// for everyone else since CachedActor doesn't carry email yet);
    /// agents get a mono `kind · status` line.
    private var subtitle: String {
        if isMe {
            return "you"
        }
        if actor.isMember { return actor.roleLabel }
        let kind: String
        switch actor.defaultAgentType {
        case "claude", "claude_code": kind = "Claude"
        case "opencode":    kind = "OpenCode"
        case "codex":       kind = "Codex"
        default:            kind = "Agent"
        }
        let status = actor.agentStatus ?? ""
        return status.isEmpty ? kind : "\(kind) · \(status)"
    }

    /// Render the human subtitle in mono only for the signed-in user, so
    /// the "you" line reads as an identifier (matches the handoff). Other
    /// humans keep the proportional caption.
    private var subtitleIsMonospaced: Bool {
        actor.isAgent || isMe
    }

    /// Deterministic placeholder while a real per-actor session aggregate
    /// lands. Stable per actor so the value doesn't churn between rebuilds.
    /// Online actors skew higher than offline ones to match the design intent.
    private var mockActiveSessions: Int {
        let h = abs(actor.actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
        let onlineBuckets:  [Int] = [0, 1, 1, 1, 2, 2, 3]
        let offlineBuckets: [Int] = [0, 0, 0, 0, 1, 1]
        let bucket = actor.isOnline ? onlineBuckets : offlineBuckets
        return bucket[h % bucket.count]
    }

    private struct Tag {
        let text: String
        let foreground: Color
        let background: Color
    }

    private var tag: Tag? {
        // YOU is the only tag that earns Cinnabar — it answers "is this me?"
        // which is the most important call-out in the list. Owner/Agent
        // step back into Basalt-on-Pebble per the wabi-sabi quietness rule.
        if isMe {
            return Tag(text: "YOU",
                       foreground: Color.amux.cinnabar,
                       background: Color.amux.cinnabar.opacity(0.10))
        }
        if actor.isOwner {
            return Tag(text: "OWNER",
                       foreground: Color.amux.basalt,
                       background: Color.amux.pebble)
        }
        if actor.isAgent {
            return Tag(text: "AGENT",
                       foreground: Color.amux.basalt,
                       background: Color.amux.pebble)
        }
        return nil
    }

    var body: some View {
        HStack(spacing: 14) {
            avatarTile

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(actor.displayName)
                        .font(.body)
                        .fontWeight(.semibold)
                        .lineLimit(1)
                    if let tag {
                        Text(tag.text)
                            .font(.system(size: 9.5, weight: .bold))
                            .tracking(0.3)
                            .foregroundStyle(tag.foreground)
                            .padding(.horizontal, 6)
                            .frame(height: 16)
                            .background(
                                RoundedRectangle(cornerRadius: 4, style: .continuous)
                                    .fill(tag.background)
                            )
                    }
                }
                Text(subtitle)
                    .font(subtitleIsMonospaced
                          ? .system(.caption, design: .monospaced)
                          : .caption)
                    .foregroundStyle(Color.amux.slate)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if mockActiveSessions > 0 {
                activeSessionsChip
            }
        }
        .padding(.vertical, 4)
    }

    private var activeSessionsChip: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(actor.isOnline ? Color.amux.sage : Color.amux.slate)
                .frame(width: 6, height: 6)
                .breathingOpacity(active: actor.isOnline, dim: 0.5)
            Text("\(mockActiveSessions)")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Color.amux.basalt)
        }
    }

    private var avatarTile: some View {
        let style = avatarStyle
        return ZStack(alignment: .bottomTrailing) {
            Group {
                if actor.isAgent {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(style.background)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(Color.amux.hairline, lineWidth: 0.5)
                        )
                } else {
                    Circle().fill(style.background)
                }
            }
            .frame(width: 40, height: 40)
            .overlay {
                if let urlString = actor.avatarURL, let url = URL(string: urlString) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            Text(avatarInitials)
                                .font(.system(size: 14, weight: .bold))
                                .tracking(-0.3)
                                .foregroundStyle(style.foreground)
                        }
                    }
                    .clipShape(actor.isAgent
                        ? AnyShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        : AnyShape(Circle()))
                } else {
                    Text(avatarInitials)
                        .font(.system(size: 14, weight: .bold))
                        .tracking(-0.3)
                        .foregroundStyle(style.foreground)
                }
            }

            if actor.isOnline {
                Circle()
                    .fill(Color.amux.sage)
                    .frame(width: 11, height: 11)
                    // Ring matches the row background (Mist), not iOS
                    // systemBackground, so the online dot reads as a clean
                    // pip on the Hai paper instead of a white halo.
                    .overlay(Circle().stroke(Color.amux.mist, lineWidth: 2.5))
                    .breathingOpacity(active: true, dim: 0.55)
                    .offset(x: 1, y: 1)
            }
        }
    }
}

struct ActorDetailView: View {
    @Query(sort: \CachedActor.displayName) private var cachedActors: [CachedActor]
    @Query(sort: \Session.lastMessageAt, order: .reverse) private var allSessions: [Session]
    @Query private var allMessages: [SessionMessage]
    let actor: CachedActor
    let pairing: PairingManager
    let mqtt: MQTTService
    let sessionViewModel: SessionListViewModel
    let store: ActorStore
    let teamclawService: TeamclawService?
    let connectedAgentsStore: ConnectedAgentsStore?
    var workspacesRepository: (any WorkspaceRepository)?
    var agentAccessRepository: (any AgentAccessRepository)?
    @Environment(\.dismiss) private var dismiss
    @State private var authorizedHumansStore: AgentAuthorizedHumansStore?
    @State private var workspaceStore: WorkspaceStore?
    @State private var newWorkspacePath = ""
    @State private var workspaceErrorMessage: String?
    @State private var isAddingWorkspace = false
    @State private var isCreatingInvite = false
    @State private var inviteErrorMessage: String?
    @State private var createdInvite: InviteCreated?
    @State private var showInviteSheet = false
    @State private var showAddAuthorizedMembersSheet = false
    @State private var isGrantingAuthorizedMembers = false
    @State private var showDeleteConfirm = false
    @State private var isDeleting = false
    @State private var deleteErrorMessage: String?
    @State private var autoApprovedOverrides: [String: Bool] = [:]
    @State private var isSavingDefaults = false
    @State private var defaultsErrorMessage: String?
    @State private var myDefaultAgentID: String?
    @State private var didLoadMyDefault = false
    @State private var isSavingMyDefault = false
    @State private var myDefaultErrorMessage: String?

    /// Routing actor id for the agent being viewed (== its id) — only meaningful when
    /// `actor` is itself an agent. Empty for humans (where workspace
    /// management isn't offered) or when ConnectedAgentsStore hasn't yet
    /// resolved this agent's row.
    private var routeActorID: String {
        guard !actor.isMember,
              let agent = connectedAgentsStore?.agents.first(where: { $0.id == actor.actorId }) else {
            return ""
        }
        return agent.id.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canManageWorkspaces: Bool {
        !routeActorID.isEmpty &&
        mqtt.connectionState == .connected
    }

    private var reinviteButtonTitle: String {
        actor.isAgent
            ? "Regenerate Invite Link"
            : "Generate Re-invite Link"
    }

    private var reinviteFootnote: String {
        actor.isAgent
            ? "Use this if the daemon was wiped and needs to re-pair."
            : "Use this if the user signed out and lost access. Only available for anonymous accounts."
    }

    private var availableAuthorizedMemberCandidates: [CachedActor] {
        let authorizedIDs = Set(authorizedHumansStore?.humans.map(\.id) ?? [])
        return cachedActors.filter { candidate in
            candidate.teamId == actor.teamId &&
            candidate.isMember &&
            !authorizedIDs.contains(candidate.actorId)
        }
    }

    var body: some View {
        List {
            heroSection
            statsSection
            if actor.isAgent {
                toolsUsedSection
                recentSessionsSection
                autoApprovedToolsSection
            }
            Section("Info") {
                Group {
                    LabeledContent("Name", value: actor.displayName)
                    LabeledContent("Kind", value: actor.isMember ? "Human" : "Agent")
                    if actor.isMember {
                        LabeledContent("Role",   value: actor.roleLabel)
                        LabeledContent("Status", value: actor.memberStatus?.capitalized ?? "—")
                        if let email = actor.email, !email.isEmpty {
                            LabeledContent("Email", value: email)
                                .textSelection(.enabled)
                        }
                        if let phone = actor.phone, !phone.isEmpty {
                            LabeledContent("Phone", value: phone)
                                .textSelection(.enabled)
                        }
                    } else {
                        LabeledContent("Agent type", value: actor.defaultAgentType ?? actor.agentTypes.first ?? "—")
                        LabeledContent("Status",     value: actor.agentStatus?.capitalized ?? "—")
                    }
                    LabeledContent("Joined",
                                   value: actor.createdAt.formatted(date: .abbreviated, time: .shortened))
                }
                .listRowBackground(Color.amux.paper)
            }
            if !actor.isMember, let store = authorizedHumansStore {
                Section("Authorized Members") {
                    Group {
                        if store.humans.isEmpty && !store.isLoading {
                            Text("No members authorized yet.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(store.humans) { human in
                                AuthorizedHumanRow(human: human)
                            }
                        }

                        if store.canManage {
                            Button {
                                showAddAuthorizedMembersSheet = true
                            } label: {
                                HStack {
                                    Label("Add Member", systemImage: "person.badge.plus")
                                    Spacer()
                                    if isGrantingAuthorizedMembers {
                                        ProgressView()
                                            .controlSize(.small)
                                    }
                                }
                            }
                            .disabled(isGrantingAuthorizedMembers || availableAuthorizedMemberCandidates.isEmpty)

                            if availableAuthorizedMemberCandidates.isEmpty {
                                Text("All team members are already authorized.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("Added members get Prompt access.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        if let err = store.errorMessage {
                            Text(err).font(.footnote).foregroundStyle(Color.amux.cinnabarDeep)
                        }
                    }
                    .listRowBackground(Color.amux.paper)
                }
            }
            if actor.isAgent {
                myDefaultSection
                defaultsSection
                Section("Workspaces") {
                    Group {
                    if let workspaceStore, workspaceStore.isLoading && workspaceStore.workspaces.isEmpty {
                        ProgressView("Loading workspaces…")
                    } else if let workspaceStore {
                        if workspaceStore.workspaces.isEmpty {
                            Text("No workspaces yet.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(workspaceStore.workspaces) { workspace in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(workspace.displayName)
                                        .font(.body)
                                    Text(workspace.path)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    } else {
                        Text("Workspace list unavailable.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    if let workspaceStore, let workspaceLoadError = workspaceStore.errorMessage {
                        Text(workspaceLoadError)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                    }

                    HStack(spacing: 8) {
                        TextField("/Users/me/project", text: $newWorkspacePath)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        Button {
                            addWorkspace()
                        } label: {
                            if isAddingWorkspace {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(width: 22, height: 22)
                            } else {
                                Image(systemName: "plus.circle.fill")
                                    .font(.title3)
                                    .symbolRenderingMode(.hierarchical)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(
                            !canManageWorkspaces ||
                            isAddingWorkspace ||
                            newWorkspacePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                    }

                    if routeActorID.isEmpty {
                        Text("Daemon routing is unavailable. Set the daemon device ID in Settings before adding workspaces.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if mqtt.connectionState != .connected {
                        Text("Connect to the daemon before adding workspaces.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if let workspaceErrorMessage {
                        Text(workspaceErrorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                    }
                    }
                    .listRowBackground(Color.amux.paper)
                }
            }
            Section {
                Group {
                    Button {
                        createInvite()
                    } label: {
                        HStack {
                            Label(reinviteButtonTitle, systemImage: "link.badge.plus")
                            Spacer()
                            if isCreatingInvite {
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(isCreatingInvite || isDeleting)

                    Text(reinviteFootnote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.amux.paper)
            } header: {
                Text("Re-invite")
            }
            Section {
                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    HStack {
                        Spacer()
                        if isDeleting {
                            ProgressView()
                        } else {
                            Text(actor.isMember ? "Remove Member" : "Remove Agent")
                                .fontWeight(.medium)
                                .foregroundStyle(Color.amux.cinnabarDeep)
                        }
                        Spacer()
                    }
                }
                .disabled(isDeleting)
                .listRowBackground(Color.amux.paper)
                // Attach dialog to the button so iOS 26's popover-style
                // confirmation anchors at the tapped row, not at the top
                // of the scroll view where the body-level modifier lived.
                .confirmationDialog(
                    actor.isMember ? "Remove \(actor.displayName) from the team?" : "Remove agent \(actor.displayName)?",
                    isPresented: $showDeleteConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Remove", role: .destructive) { performDelete() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(actor.isMember
                         ? "They will lose access to all of this team's ideas and sessions."
                         : "The agent's Supabase identity, daemon credentials, and member authorizations will be deleted.")
                }
                if let inviteErrorMessage {
                    Text(inviteErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
                if let deleteErrorMessage {
                    Text(deleteErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
            }
        }
        // Inset-grouped natively gives rounded sections + side margin —
        // the paper-card pattern from `actor-detail.jsx`. We hide the
        // default grouped background (gray gaps) so Mist shows through,
        // then paint each row Paper via listRowBackground. The hero
        // stays clear so the avatar floats on Mist.
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.amux.mist)
        .navigationTitle(actor.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.amux.mist.opacity(0.85), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            guard !actor.isMember, authorizedHumansStore == nil else { return }
            if let repo = agentAccessRepository {
                let store = AgentAuthorizedHumansStore(agentID: actor.actorId, teamID: actor.teamId, repository: repo)
                authorizedHumansStore = store
                await store.reload()
            }
        }
        .task {
            guard actor.isAgent, workspaceStore == nil else { return }
            if let repo = workspacesRepository {
                let store = WorkspaceStore(teamID: actor.teamId, repository: repo)
                workspaceStore = store
                await store.reload(agentID: actor.actorId)
            }
        }
        .task {
            guard actor.isAgent, !didLoadMyDefault else { return }
            didLoadMyDefault = true
            myDefaultAgentID = await store.getMemberDefaultAgent()
        }
        .sheet(isPresented: $showInviteSheet) {
            if let createdInvite {
                InviteShareSheet(invite: createdInvite)
            }
        }
        .sheet(isPresented: $showAddAuthorizedMembersSheet) {
            AuthorizedMemberPickerSheet(candidates: availableAuthorizedMemberCandidates) { selectedMembers in
                grantAuthorizedMembers(selectedMembers)
            }
        }
        .refreshable {
            await authorizedHumansStore?.reload()
            await workspaceStore?.reload(agentID: actor.actorId)
        }
    }

    private func performDelete() {
        guard !isDeleting else { return }
        isDeleting = true
        deleteErrorMessage = nil
        Task {
            let ok = await store.removeActor(actorID: actor.actorId)
            await MainActor.run {
                isDeleting = false
                if ok {
                    dismiss()
                } else {
                    deleteErrorMessage = store.errorMessage ?? "Delete failed."
                }
            }
        }
    }

    private func createInvite() {
        guard !isCreatingInvite else { return }
        isCreatingInvite = true
        inviteErrorMessage = nil

        Task {
            let input: InviteCreateInput
            if actor.isAgent {
                input = InviteCreateInput(
                    kind: .agent,
                    displayName: actor.displayName,
                    agentKind: "daemon",
                    targetActorID: actor.actorId
                )
            } else {
                let role = TeamRole(rawValue: actor.teamRole ?? "member") ?? .member
                input = InviteCreateInput(
                    kind: .member,
                    displayName: actor.displayName,
                    teamRole: role,
                    targetActorID: actor.actorId
                )
            }
            let invite = await store.createInvite(input)
            await MainActor.run {
                isCreatingInvite = false
                if let invite {
                    createdInvite = invite
                    showInviteSheet = true
                } else {
                    inviteErrorMessage = friendlyInviteError(store.errorMessage)
                }
            }
        }
    }

    private func friendlyInviteError(_ raw: String?) -> String {
        guard let raw else { return "Failed to create invite." }
        if raw.contains("cannot re-invite member with bound auth identity") {
            return "This member signs in via Apple/Google/email — they recover by signing back in, no re-invite needed."
        }
        if raw.contains("target member is no longer anonymous") {
            return "This member upgraded their account since the invite was created. Re-invite is no longer applicable."
        }
        return raw
    }

    private func addWorkspace() {
        let path = newWorkspacePath.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty else { return }

        guard !routeActorID.isEmpty else {
            workspaceErrorMessage = "Missing daemon device ID."
            return
        }
        guard mqtt.connectionState == .connected else {
            workspaceErrorMessage = "MQTT is not connected."
            return
        }
        guard let teamclawService else {
            workspaceErrorMessage = "TeamclawService unavailable."
            return
        }

        isAddingWorkspace = true
        workspaceErrorMessage = nil

        let target = routeActorID
        Task {
            let (ok, err) = await teamclawService.addWorkspaceRpc(targetActorID: target, path: path)
            await MainActor.run {
                isAddingWorkspace = false
                if ok {
                    newWorkspacePath = ""
                    workspaceErrorMessage = nil
                    let workspaceStore = self.workspaceStore
                    let actorId = actor.actorId
                    Task { await workspaceStore?.reload(agentID: actorId) }
                } else {
                    workspaceErrorMessage = err.isEmpty ? "Add failed" : err
                }
            }
        }
    }

    private func grantAuthorizedMembers(_ members: [CachedActor]) {
        guard !members.isEmpty, let authorizedHumansStore else { return }
        isGrantingAuthorizedMembers = true
        Task {
            var firstFailure: String?
            for member in members {
                let ok = await authorizedHumansStore.grant(memberID: member.actorId)
                if !ok, firstFailure == nil {
                    firstFailure = authorizedHumansStore.errorMessage ?? "Failed to authorize member."
                }
            }

            await MainActor.run {
                isGrantingAuthorizedMembers = false
                if let firstFailure {
                    authorizedHumansStore.errorMessage = firstFailure
                }
            }
        }
    }

    // MARK: - Hero / stats / tools / sessions / auto-approve sections

    private var actorRecentSessions: [Session] {
        if actor.isAgent {
            return allSessions.filter { $0.primaryAgentId == actor.actorId }
        }
        let sessionIds = Set(
            allMessages
                .filter { $0.senderActorId == actor.actorId }
                .map(\.sessionId)
        )
        return allSessions.filter { sessionIds.contains($0.sessionId) }
    }

    /// Deterministic placeholder counts so the stat row, tools chart, and
    /// auto-approve list look populated until real aggregates land. Stable
    /// per actor so they don't churn between rebuilds.
    private var mockHash: Int {
        abs(actor.actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
    }

    private var mockSessionCount: Int {
        let real = actorRecentSessions.count
        if real > 0 { return real }
        return [4, 7, 12, 14, 21][mockHash % 5]
    }

    private var mockSubmissionCount: Int { [12, 28, 38, 56, 84][mockHash % 5] }
    private var mockToolCallCount: Int   { [88, 142, 224, 318, 502][mockHash % 5] }

    private struct ToolBar { let name: String; let count: Int }
    private var mockTools: [ToolBar] {
        let base = [142, 38, 24, 12, 8]
        let names = ["Read", "Edit", "Bash", "Write", "Grep"]
        return zip(names, base).enumerated().map { i, pair in
            // Slight per-actor jitter so the chart isn't identical across agents.
            let delta = (mockHash &+ i) % 7
            return ToolBar(name: pair.0, count: max(1, pair.1 + delta - 3))
        }
    }

    private struct AutoApprovedRow { let name: String; let defaultOn: Bool }
    private static let autoApprovedRows: [AutoApprovedRow] = [
        AutoApprovedRow(name: "Read · any path", defaultOn: true),
        AutoApprovedRow(name: "Edit · within worktree", defaultOn: true),
        AutoApprovedRow(name: "Bash · npm test, cargo test", defaultOn: true),
        AutoApprovedRow(name: "Write · new files only", defaultOn: false),
    ]

    @ViewBuilder
    private var heroSection: some View {
        Section {
            VStack(spacing: 10) {
                heroAvatar
                Text(actor.displayName)
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                Text(heroIdLine)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                heroTagRow
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
    }

    private var heroAvatar: some View {
        ZStack(alignment: .bottomTrailing) {
            AgentAvatar(actor: actor, size: 72, cornerRadius: 18)
                .shadow(color: heroAvatarShadow.opacity(0.18), radius: 14, y: 4)
            if actor.isOnline {
                ZStack {
                    Circle()
                        .fill(Color.amux.sage)
                        .frame(width: 18, height: 18)
                    Circle()
                        .fill(Color.amux.mist)
                        .frame(width: 6, height: 6)
                        .breathingOpacity(active: true)
                }
                .overlay(
                    Circle().stroke(Color(.systemGroupedBackground), lineWidth: 3)
                )
                .offset(x: 2, y: 2)
            }
        }
    }

    private var heroAvatarShadow: Color {
        // Hai keeps every avatar glow in the ink-and-stone family — a soft
        // Onyx shadow that just deepens the paper. The previous brand-tint
        // glow has been retired with the rest of the rainbow.
        Color.amux.onyx
    }

    private var heroIdLine: String {
        actor.actorId
    }

    @ViewBuilder
    private var heroTagRow: some View {
        let tags = heroTags
        if !tags.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                    Text(tag.text)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tag.fg)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(tag.bg))
                }
            }
        }
    }

    private struct HeroTag { let text: String; let fg: Color; let bg: Color }

    private var heroTags: [HeroTag] {
        var out: [HeroTag] = []
        if actor.isAgent {
            // Placeholder: surface the supported agent backends until the
            // real per-agent type/capability metadata lands.
            for name in ["Claude code", "Opencode", "Codex"] {
                out.append(HeroTag(text: name,
                                   fg: Color.amux.basalt,
                                   bg: Color.amux.pebble))
            }
        }
        if actor.isOwner {
            out.append(HeroTag(text: "Owner",
                               fg: Color.amux.basalt,
                               bg: Color.amux.pebble))
        }
        return out
    }

    @ViewBuilder
    private var statsSection: some View {
        Section {
            HStack(spacing: 0) {
                statBlock(label: "Sessions", value: mockSessionCount)
                statDivider
                statBlock(label: "Skills",   value: mockSubmissionCount)
                statDivider
                statBlock(label: actor.isMember ? "Token used" : "MCP",
                          value: mockToolCallCount)
            }
            .padding(.vertical, 8)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.amux.paper)
        }
    }

    private func statBlock(label: String, value: Int) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.system(size: 22, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.primary)
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var statDivider: some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.15))
            .frame(width: 0.5, height: 28)
    }

    @ViewBuilder
    private var toolsUsedSection: some View {
        Section {
            ForEach(Array(mockTools.enumerated()), id: \.offset) { _, t in
                ToolUsageRow(name: t.name, count: t.count, max: maxToolCount)
                    .listRowBackground(Color.amux.paper)
            }
        } header: {
            Text("Top 5 skills used".uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.3)
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
    }

    private var maxToolCount: Int {
        max(1, mockTools.map(\.count).max() ?? 1)
    }

    @ViewBuilder
    private var recentSessionsSection: some View {
        Section {
            if actorRecentSessions.isEmpty {
                Text("No recent sessions yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.amux.paper)
            } else {
                ForEach(actorRecentSessions.prefix(5), id: \.sessionId) { s in
                    RecentSessionRow(session: s)
                        .listRowBackground(Color.amux.paper)
                }
            }
        } header: {
            Text("Recent sessions".uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.3)
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
    }

    @ViewBuilder
    private var autoApprovedToolsSection: some View {
        Section {
            ForEach(Self.autoApprovedRows, id: \.name) { row in
                Toggle(isOn: autoApprovedBinding(for: row)) {
                    Text(row.name)
                        .font(.subheadline)
                }
                .tint(Color.amux.cinnabar)
                .listRowBackground(Color.amux.paper)
            }
        } header: {
            Text("Auto-approved tools".uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.3)
                .foregroundStyle(.secondary)
                .textCase(nil)
        } footer: {
            Text("These tools run without a prompt. Real persistence will land alongside the per-agent permission spec.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func autoApprovedBinding(for row: AutoApprovedRow) -> Binding<Bool> {
        Binding(
            get: { autoApprovedOverrides[row.name] ?? row.defaultOn },
            set: { autoApprovedOverrides[row.name] = $0 }
        )
    }

    // MARK: - My default agent
    //
    // Per-viewer preference (members.default_agent_id): whether *this* agent is
    // the signed-in member's personal default, with a toggle to set/clear it.
    // Distinct from the agent-owned `defaultsSection` below.

    private var isMyDefaultAgent: Bool {
        actor.isAgent && myDefaultAgentID == actor.actorId
    }

    @ViewBuilder
    private var myDefaultSection: some View {
        Section {
            Group {
                HStack(spacing: 10) {
                    Image(systemName: isMyDefaultAgent ? "star.fill" : "star")
                        .foregroundStyle(isMyDefaultAgent ? Color.amux.cinnabar : Color.amux.slate)
                    Text(isMyDefaultAgent ? "Your default agent" : "Not your default")
                        .foregroundStyle(Color.amux.basalt)
                    Spacer()
                    if isSavingMyDefault {
                        ProgressView().controlSize(.small)
                    } else if isMyDefaultAgent {
                        Button("Remove") { saveMyDefault(makeDefault: false) }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.amux.slate)
                    } else {
                        Button("Set as default") { saveMyDefault(makeDefault: true) }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.amux.basalt)
                    }
                }

                if let myDefaultErrorMessage {
                    Text(myDefaultErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
            }
            .listRowBackground(Color.amux.paper)
        } header: {
            Text("My Default")
        } footer: {
            Text("Your personal default agent — pre-selected when you start a new session.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func saveMyDefault(makeDefault: Bool) {
        guard !isSavingMyDefault else { return }
        isSavingMyDefault = true
        myDefaultErrorMessage = nil
        let target: String? = makeDefault ? actor.actorId : nil
        Task {
            let result = await store.setMemberDefaultAgent(agentID: target)
            await MainActor.run {
                isSavingMyDefault = false
                if result.ok {
                    myDefaultAgentID = result.value
                } else {
                    myDefaultErrorMessage = store.errorMessage ?? "Failed to update default agent."
                }
            }
        }
    }

    // MARK: - Defaults section
    //
    // Per-agent defaults that New Session and Add Agent flows read so the user
    // doesn't have to repeat workspace + agent-type picks. Backed by
    // `agents.default_workspace_id` and `agents.default_agent_type`.

    private static let agentKindOptions: [(String, String)] = [
        ("claude", "Claude"),
        ("opencode",    "OpenCode"),
        ("codex",       "Codex"),
    ]

    private var supportedAgentKindOptions: [(String, String)] {
        let supported = Set(actor.agentTypes.map {
            $0 == "claude_code" || $0 == "claude-code" ? "claude" : $0
        })
        guard !supported.isEmpty else { return Self.agentKindOptions }
        return Self.agentKindOptions.filter { supported.contains($0.0) }
    }

    @ViewBuilder
    private var defaultsSection: some View {
        Section {
            Group {
                Picker("Default workspace", selection: defaultWorkspaceBinding) {
                    Text("None").tag(String?.none)
                    if let workspaceStore {
                        ForEach(workspaceStore.workspaces) { ws in
                            Text(ws.displayName.isEmpty ? ws.path : ws.displayName)
                                .tag(Optional(ws.id))
                        }
                    }
                }
                .disabled(isSavingDefaults || (workspaceStore?.workspaces.isEmpty ?? true))

                Picker("Agent type", selection: agentKindBinding) {
                    ForEach(supportedAgentKindOptions, id: \.0) { kind, label in
                        Text(label).tag(kind)
                    }
                }
                .disabled(isSavingDefaults)

                if isSavingDefaults {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Saving…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if let defaultsErrorMessage {
                    Text(defaultsErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
            }
            .listRowBackground(Color.amux.paper)
        } header: {
            Text("Defaults")
        } footer: {
            Text("Used when this agent is added to a new session — picks are pre-filled, no extra taps needed.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var defaultWorkspaceBinding: Binding<String?> {
        Binding(
            get: { actor.defaultWorkspaceId },
            set: { newValue in saveDefaults(workspaceID: newValue, defaultAgentType: nil) }
        )
    }

    private var agentKindBinding: Binding<String> {
        Binding(
            get: {
                let raw = actor.defaultAgentType ?? actor.agentTypes.first ?? "claude"
                if raw == "claude_code" { return "claude" }
                return supportedAgentKindOptions.contains(where: { $0.0 == raw }) ? raw : (supportedAgentKindOptions.first?.0 ?? "claude")
            },
            set: { newValue in saveDefaults(workspaceID: nil, defaultAgentType: newValue) }
        )
    }

    private func saveDefaults(workspaceID: String?, defaultAgentType: String?) {
        guard !isSavingDefaults else { return }
        // Apply the local change immediately so the picker reflects the new
        // value before the round-trip completes. ActorStore.reload() will
        // overwrite if the RPC succeeds.
        if let workspaceID {
            actor.defaultWorkspaceId = workspaceID
        }
        if let defaultAgentType {
            actor.defaultAgentType = defaultAgentType
        }
        isSavingDefaults = true
        defaultsErrorMessage = nil
        let actorID = actor.actorId
        Task {
            let result = await store.updateAgentDefaults(
                actorID: actorID,
                defaultWorkspaceID: workspaceID,
                agentKind: nil,
                defaultAgentType: defaultAgentType
            )
            await MainActor.run {
                isSavingDefaults = false
                if result == nil {
                    defaultsErrorMessage = store.errorMessage ?? "Failed to save defaults."
                }
            }
        }
    }
}

private struct ToolUsageRow: View {
    let name: String
    let count: Int
    let max: Int

    private var ratio: CGFloat {
        max <= 0 ? 0 : CGFloat(count) / CGFloat(max)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(count)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.amux.pebble)
                    Capsule()
                        .fill(LinearGradient(
                            colors: [Color.amux.pebble, Color.amux.cinnabar],
                            startPoint: .leading, endPoint: .trailing
                        ))
                        .frame(width: proxy.size.width * ratio)
                }
            }
            .frame(height: 4)
        }
        .padding(.vertical, 2)
    }
}

private struct RecentSessionRow: View {
    let session: Session

    private var dotColor: Color {
        // No live runtime in scope here; rely on lastMessageAt freshness as a
        // cheap proxy until the actor-detail view holds a live runtime store.
        let staleSeconds: TimeInterval = 300
        if let last = session.lastMessageAt,
           Date().timeIntervalSince(last) < staleSeconds {
            return Color.amux.sage
        }
        return Color.amux.slate
    }

    private var when: Date { session.lastMessageAt ?? session.createdAt }

    private func formatted(_ date: Date) -> String {
        let s = Int(-date.timeIntervalSinceNow)
        if s < 60     { return "now" }
        if s < 3600   { return "\(s/60)m" }
        if s < 86400  { return "\(s/3600)h" }
        if s < 604800 { return "\(s/86400)d" }
        let f = DateFormatter(); f.dateFormat = "MM/dd"
        return f.string(from: date)
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
            Text(session.title.isEmpty ? "Untitled session" : session.title)
                .font(.subheadline)
                .lineLimit(1)
            Spacer()
            Text(formatted(when))
                .font(.caption)
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}

private struct InviteShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    let invite: InviteCreated

    var body: some View {
        NavigationStack {
            Form {
                Section("Share invite") {
                    Text(invite.deeplink)
                        .font(.footnote)
                        .textSelection(.enabled)
                        .foregroundStyle(.secondary)
                    ShareLink(item: invite.deeplink) {
                        Label("Share link", systemImage: "square.and.arrow.up")
                    }
                    Button {
                        UIPasteboard.general.string = invite.deeplink
                    } label: {
                        Label("Copy link", systemImage: "doc.on.doc")
                    }
                    LabeledContent(
                        "Expires",
                        value: invite.expiresAt.formatted(date: .abbreviated, time: .shortened)
                    )
                    .font(.caption)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .navigationTitle("Agent Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

private struct AuthorizedHumanRow: View {
    let human: AgentAuthorizedHuman
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(human.isOnline ? Color.amux.sage : Color.amux.slate.opacity(0.4))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(human.displayName).font(.body).foregroundStyle(Color.amux.onyx)
                Text(human.permissionLevel.capitalized)
                    .font(.caption).foregroundStyle(Color.amux.basalt)
            }
            Spacer()
            Text(human.isOnline ? "Online" : "Offline")
                .font(.caption)
                .foregroundStyle(human.isOnline ? Color.amux.sage : Color.amux.basalt)
        }
    }
}

private struct AuthorizedMemberPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let candidates: [CachedActor]
    let onConfirm: ([CachedActor]) -> Void

    @State private var selectedIDs: Set<String> = []
    @State private var searchText = ""

    private var filteredCandidates: [CachedActor] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return candidates }
        let normalized = query.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        return candidates.filter { candidate in
            [candidate.displayName, candidate.roleLabel, candidate.actorId]
                .joined(separator: " ")
                .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
                .contains(normalized)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if filteredCandidates.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    ForEach(filteredCandidates, id: \.actorId) { member in
                        Button {
                            if selectedIDs.contains(member.actorId) {
                                selectedIDs.remove(member.actorId)
                            } else {
                                selectedIDs.insert(member.actorId)
                            }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: selectedIDs.contains(member.actorId) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selectedIDs.contains(member.actorId) ? Color.amux.cinnabar : Color.amux.slate)
                                    .font(.title3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.displayName).font(.body)
                                    Text(member.roleLabel).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .searchable(text: $searchText, prompt: "Search members")
            .navigationTitle("Add Members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Add") {
                        onConfirm(candidates.filter { selectedIDs.contains($0.actorId) })
                        dismiss()
                    }
                    .disabled(selectedIDs.isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

#else
struct MemberListContent: View {
    init(store: ActorStore, pairing: PairingManager, mqtt: MQTTService, sessionViewModel: SessionListViewModel, teamclawService: TeamclawService?) {}
    var body: some View { ContentUnavailableView("Actors", systemImage: "person.2") }
}
#endif
