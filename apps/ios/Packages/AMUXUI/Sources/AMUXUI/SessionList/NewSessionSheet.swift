import SwiftUI
import AMUXSharedUI
import SwiftData
import AMUXCore
import os

private let newSessionLogger = Logger(subsystem: "tech.teamclaw.mobile", category: "NewSession")

// MARK: - NewSessionSheet

public struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let mqtt: MQTTService
    let peerId: String
    let teamclawService: TeamclawService?
    let teamID: String
    let currentActorID: String?
    let isAgentAvailable: Bool
    let connectedAgentsStore: ConnectedAgentsStore?

    let viewModel: SessionListViewModel
    let preselectedIdeaId: String?
    let preselectedCollaborators: [CachedActor]

    // Per-agent config (workspace + agent type) keyed by actorId
    @State private var agentConfigs: [String: AgentConfigSheet.Selection] = [:]
    // The agent actor currently awaiting AgentConfigSheet presentation
    @State private var pendingAgentConfig: CachedActor?
    @State private var workspaceStore: WorkspaceStore?

    @State private var collaborators: [CachedActor] = []
    @State private var selectedIdeaId: String?
    @State private var messageText: String = ""
    @State private var showMemberPicker = false
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var debugStatusMessage: String?
    @State private var debugTransportMessage: String?
    @FocusState private var isInputFocused: Bool

    @Query(filter: #Predicate<SessionIdea> { !$0.archived },
           sort: \SessionIdea.createdAt, order: .reverse)
    private var ideas: [SessionIdea]

    private var workspaces: [WorkspaceRecord] { workspaceStore?.workspaces ?? [] }
    private var availableIdeas: [SessionIdea] { ideas }

    /// Set by parent — called with agentId when session is created
    var onSessionCreated: ((String) -> Void)?

    public init(mqtt: MQTTService, peerId: String, teamclawService: TeamclawService? = nil,
                teamID: String = "", currentActorID: String? = nil, isAgentAvailable: Bool = true,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                viewModel: SessionListViewModel,
                preselectedIdeaId: String? = nil,
                preselectedCollaborators: [CachedActor] = [],
                onSessionCreated: ((String) -> Void)? = nil) {
        self.mqtt = mqtt
        self.peerId = peerId
        self.teamclawService = teamclawService
        self.teamID = teamID
        self.currentActorID = currentActorID
        self.isAgentAvailable = isAgentAvailable
        self.connectedAgentsStore = connectedAgentsStore
        self.viewModel = viewModel
        self.preselectedIdeaId = preselectedIdeaId
        self.preselectedCollaborators = preselectedCollaborators
        self.onSessionCreated = onSessionCreated
    }

    private var canSend: Bool {
        let textOK = !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // At least one other actor (agent or human) must be picked.
        let hasOtherActor = !collaborators.isEmpty
        // Every agent collaborator must have a confirmed AgentConfigSheet selection.
        let agentsConfigured = collaborators
            .filter { $0.isAgent }
            .allSatisfy { agentConfigs[$0.actorId] != nil }
        return textOK && hasOtherActor && agentsConfigured
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                VStack(spacing: 0) {
                    collaboratorsRow
                    Divider()
                    ideaRow
                    Divider()
                    Spacer()
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                    }
#if DEBUG
                    if let debugStatusMessage, !debugStatusMessage.isEmpty {
                        Text(debugStatusMessage)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                            .lineLimit(2)
                            .accessibilityIdentifier("newSession.debugStatus")
                    }
                    if let debugTransportMessage, !debugTransportMessage.isEmpty {
                        Text(debugTransportMessage)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                            .accessibilityIdentifier("newSession.debugTransport")
                    }
#endif
                    inputBar
                }
                if isSending {
                    Color.black.opacity(0.15).ignoresSafeArea()
                    ProgressView("Starting session…")
                        .padding(24)
                        .liquidGlass(in: RoundedRectangle(cornerRadius: 12), interactive: false)
                }
            }
            .allowsHitTesting(!isSending)
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .disabled(isSending)
                }
            }
        }
        .sheet(isPresented: $showMemberPicker) {
            MemberListView(
                selected: Set(collaborators.filter { !$0.isAgent }.map(\.actorId)),
                accessibleAgentIDs: Set(connectedAgentsStore?.agents.map(\.id) ?? []),
                currentPrimaryAgentID: nil,
                excludeActorID: currentActorID,
                externallySelectedIDs: Set(agentConfigs.keys),
                onAgentTap: { actor in
                    if agentConfigs[actor.actorId] != nil {
                        // Tapping an already-configured agent deselects it.
                        agentConfigs.removeValue(forKey: actor.actorId)
                        collaborators.removeAll { $0.actorId == actor.actorId }
                    } else {
                        pendingAgentConfig = actor
                    }
                }
            ) { selected in
                // `selected` includes humans (from internal selectedIDs) +
                // agents already added via per-tap config (passed in via
                // externallySelectedIDs). Replace collaborators wholesale.
                collaborators = selected
            }
            .task { await connectedAgentsStore?.reload() }
            // AgentConfigSheet stacks on top of the picker so the user
            // configures one agent and stays in the picker to keep
            // selecting (multiple agents = multiple sequential
            // AgentConfigSheet presentations, one per tap).
            .sheet(item: $pendingAgentConfig) { actor in
                let agentWorkspaces = workspaces
                    .filter { $0.agentID == actor.actorId }
                    .map { WorkspaceRef(id: $0.id, path: $0.displayName.isEmpty ? $0.path : $0.displayName) }
                let allWorkspaceRefs = agentWorkspaces.isEmpty
                    ? workspaces.map { WorkspaceRef(id: $0.id, path: $0.displayName.isEmpty ? $0.path : $0.displayName) }
                    : agentWorkspaces
                AgentConfigSheet(
                    actorDisplayName: actor.displayName,
                    workspaces: allWorkspaceRefs,
                    onConfirm: { sel in
                        agentConfigs[actor.actorId] = sel
                        if !collaborators.contains(where: { $0.actorId == actor.actorId }) {
                            collaborators.append(actor)
                        }
                        pendingAgentConfig = nil
                    },
                    onCancel: {
                        // Don't add the agent — leave selection unchanged.
                        pendingAgentConfig = nil
                    }
                )
            }
        }
        .onAppear {
            isInputFocused = true
            if selectedIdeaId == nil, let preselectedIdeaId {
                selectedIdeaId = preselectedIdeaId
            }
            if collaborators.isEmpty, !preselectedCollaborators.isEmpty {
                collaborators = preselectedCollaborators
            }
        }
        .task {
            guard workspaceStore == nil, !teamID.isEmpty else { return }
            if let repository = try? SupabaseWorkspaceRepository() {
                workspaceStore = WorkspaceStore(teamID: teamID, repository: repository)
                // Load all workspaces (no agent filter) so AgentConfigSheet
                // can show options before the user taps each agent.
                await workspaceStore?.reload(agentID: nil)
            }
        }
    }

    // MARK: - Collaborators row

    private var collaboratorsRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("Collaborators")
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if collaborators.isEmpty {
                        Text("Just you")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(collaborators, id: \.actorId) { member in
                            CollaboratorChip(name: member.displayName) {
                                removeCollaborator(member)
                            }
                        }
                    }
                }
                .padding(.vertical, 1)
            }

            Spacer(minLength: 0)

            Button {
                showMemberPicker = true
                isInputFocused = false
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Idea row

    private var ideaRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(IdeaUIPresentation.singularTitle)
                .foregroundStyle(.secondary)
            Spacer()
            Menu {
                Button {
                    selectedIdeaId = nil
                } label: {
                    Label("None", systemImage: selectedIdeaId == nil ? "checkmark" : "circle")
                }
                if !availableIdeas.isEmpty {
                    Divider()
                    ForEach(availableIdeas, id: \.ideaId) { item in
                        Button {
                            selectedIdeaId = item.ideaId
                        } label: {
                            Label(item.displayTitle,
                                  systemImage: selectedIdeaId == item.ideaId ? "checkmark" : "circle")
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(selectedIdeaLabel)
                        .font(.body)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption)
                }
                .foregroundStyle(selectedIdeaId == nil ? .secondary : .primary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private var selectedIdeaLabel: String {
        if let id = selectedIdeaId,
           let item = ideas.first(where: { $0.ideaId == id }) {
            return item.displayTitle
        }
        return "None"
    }

    // MARK: - Input bar

    private var inputBar: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 4) {
                    TextField("Message", text: $messageText, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...5)
                        .focused($isInputFocused)
                        .accessibilityIdentifier("newSession.messageField")
                        .padding(.leading, 14)
                        .padding(.trailing, 4)
                        .padding(.vertical, 10)

                    Button(action: sendAndCreate) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(canSend ? .blue : .gray.opacity(0.4))
                    }
                    .accessibilityIdentifier("newSession.sendButton")
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .padding(.trailing, 6)
                    .padding(.bottom, 6)
                }
                .liquidGlass(in: RoundedRectangle(cornerRadius: 20))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .padding(.bottom, 4)
    }

    // MARK: - Helpers

    /// Builds the text that will be sent as the session's first user message.
    /// If an idea is selected, its title/description prefaces the user's prompt.
    private func firstMessageText(userText: String) -> String {
        guard let id = selectedIdeaId,
              let item = ideas.first(where: { $0.ideaId == id }) else {
            return userText
        }
        let description = item.ideaDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = item.displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let ideaBlock: String
        if !description.isEmpty && !title.isEmpty && description != title {
            ideaBlock = "Idea: \(title)\n\n\(description)"
        } else if !description.isEmpty {
            ideaBlock = "Idea: \(description)"
        } else if !title.isEmpty {
            ideaBlock = "Idea: \(title)"
        } else {
            return userText
        }
        return "\(ideaBlock)\n\n\(userText)"
    }

    private func removeCollaborator(_ member: CachedActor) {
        collaborators.removeAll { $0.actorId == member.actorId }
        agentConfigs.removeValue(forKey: member.actorId)
        if pendingAgentConfig?.actorId == member.actorId {
            pendingAgentConfig = nil
        }
    }

    private func sendAndCreate() {
        let userText = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userText.isEmpty else { return }

        let text = firstMessageText(userText: userText)

        isInputFocused = false
        errorMessage = nil
        debugStatusMessage = nil

        if !isAgentAvailable {
            createLocalSession(text: text, title: userText)
            return
        }
        createSession(text: text, title: userText)
    }

    private var effectiveTeamID: String {
        teamID.isEmpty ? "teamclaw" : teamID
    }

    /// Returns the daemon device ID for the given agent actor ID, resolved
    /// from ConnectedAgentsStore.
    private func deviceID(forAgentActorID actorID: String) -> String {
        guard let agent = connectedAgentsStore?.agents.first(where: { $0.id == actorID }),
              let id = agent.deviceID, !id.isEmpty
        else { return "" }
        return id
    }

    private func createSession(text: String, title: String) {
        guard let currentActorID else {
            errorMessage = "Current actor is not ready yet."
            return
        }
        guard let teamclawService else {
            errorMessage = "Teamclaw service is not ready."
            return
        }

        // Verify all selected agents have reachable daemons before starting.
        for (agentActorID, _) in agentConfigs {
            if deviceID(forAgentActorID: agentActorID).isEmpty {
                errorMessage = "An agent's daemon is offline. Wait for it to reconnect."
                return
            }
        }

        isSending = true

        let sessionID = UUID().uuidString.lowercased()
        let firstLine = title.split(separator: "\n").first.map(String.init) ?? title
        let trimmedTitle = String(firstLine.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let createdAt = Date()
        let participantActors = sessionParticipants(currentActorID: currentActorID)
        let participantInfos = sessionInfoParticipants(
            currentActorID: currentActorID,
            createdAt: createdAt,
            participants: participantActors
        )

        let agentSpawns: [SessionCreationInput.AgentSpawn] = agentConfigs.compactMap { agentActorID, cfg in
            let routeDevice = deviceID(forAgentActorID: agentActorID)
            guard !routeDevice.isEmpty else { return nil }
            let wsPath = workspaces.first(where: { $0.id == cfg.workspaceID })?.path ?? ""
            return SessionCreationInput.AgentSpawn(
                actorID: agentActorID,
                routeDeviceID: routeDevice,
                workspaceID: cfg.workspaceID,
                workspacePath: wsPath,
                agentType: cfg.agentType.asAmuxAgentType
            )
        }

        // Auto-mention rule: when there's exactly one agent, address it
        // implicitly. Multi-agent sessions leave routing to the daemon's
        // mention-parser.
        let mentionIDs: [String] = agentConfigs.count == 1
            ? Array(agentConfigs.keys)
            : []

        let input = SessionCreationInput(
            sessionID: sessionID,
            teamID: effectiveTeamID,
            currentActorID: currentActorID,
            ideaID: selectedIdeaId,
            title: trimmedTitle,
            summary: text,
            createdAt: createdAt,
            participants: participantActors.map {
                SessionParticipantInput(
                    actorID: $0.actorId,
                    role: $0.isAgent ? "agent" : "member"
                )
            },
            participantInfos: participantInfos,
            agentSpawns: agentSpawns,
            mentionAgentActorIDs: mentionIDs
        )

        Task {
            let repository: SessionRepository
            do {
                repository = try SupabaseSessionRepository()
            } catch {
                isSending = false
                errorMessage = error.localizedDescription
                return
            }
            let useCase = SessionCreationUseCase(
                repository: repository,
                teamclawService: teamclawService,
                modelContext: modelContext
            )
            let outcome = await useCase.create(input)

            switch outcome {
            case .created(let sessionID, _):
                viewModel.reloadSessions(modelContext: modelContext)
                isSending = false
                newSessionLogger.info(
                    "session created destination=session:\(sessionID, privacy: .public)"
                )
                onSessionCreated?("session:\(sessionID)")
                dismiss()
            case .failed(let failure):
                isSending = false
                errorMessage = failure.userFacingMessage
            }
        }
    }

    private func createLocalSession(text: String, title: String) {
        guard let currentActorID else {
            errorMessage = "Current actor is not ready yet."
            return
        }

        let createdAt = Date()
        let sessionID = UUID().uuidString
        let session = Session(
            sessionId: sessionID,
            teamId: teamID,
            title: String((title.split(separator: "\n").first.map(String.init) ?? title).trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)),
            createdBy: currentActorID,
            createdAt: createdAt,
            summary: text,
            participantCount: max(collaborators.count + 1, 1),
            lastMessagePreview: text,
            lastMessageAt: createdAt,
            ideaId: selectedIdeaId ?? ""
        )

        let message = SessionMessage(
            messageId: UUID().uuidString,
            sessionId: sessionID,
            senderActorId: currentActorID,
            kind: "text",
            content: text,
            createdAt: createdAt
        )

        modelContext.insert(session)
        modelContext.insert(message)
        try? modelContext.save()
        viewModel.reloadSessions(modelContext: modelContext)
        onSessionCreated?("session:\(sessionID)")
        dismiss()
    }

    private func sessionParticipants(currentActorID: String) -> [CachedActor] {
        var deduped: [String: CachedActor] = collaborators.reduce(into: [:]) { partialResult, actor in
            partialResult[actor.actorId] = actor
        }

        if deduped[currentActorID] == nil {
            deduped[currentActorID] = CachedActor(
                actorId: currentActorID,
                teamId: teamID,
                actorType: "member",
                displayName: teamclawService?.localDisplayName.isEmpty == false ? teamclawService?.localDisplayName ?? currentActorID : currentActorID,
                teamRole: "member"
            )
        }

        return Array(deduped.values)
    }

    private func sessionInfoParticipants(
        currentActorID: String,
        createdAt: Date,
        participants: [CachedActor]
    ) -> [Teamclaw_Participant] {
        participants.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .map { actor in
                var participant = Teamclaw_Participant()
                participant.actorID = actor.actorId
                participant.actorType = actor.isAgent ? .personalAgent : .human
                participant.displayName = actor.actorId == currentActorID && !(teamclawService?.localDisplayName ?? "").isEmpty
                    ? teamclawService?.localDisplayName ?? actor.displayName
                    : actor.displayName
                participant.joinedAt = Int64(createdAt.timeIntervalSince1970)
                return participant
            }
    }

}

// MARK: - CachedActor: Identifiable for .sheet(item:)
// CachedActor is a SwiftData @Model and is already Identifiable via actorId.

// MARK: - CollaboratorChip

private struct CollaboratorChip: View {
    let name: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(name)
                .font(.subheadline)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.semibold))
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .foregroundStyle(.primary)
        .liquidGlass(in: Capsule(), interactive: false)
    }
}
