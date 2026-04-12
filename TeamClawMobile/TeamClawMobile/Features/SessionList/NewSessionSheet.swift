import SwiftUI
import SwiftData

// MARK: - NewSessionSheet

struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let mqttService: MQTTServiceProtocol
    let onCreated: (Session) -> Void

    @State private var collaborators: [TeamMember] = []
    @State private var messageText: String = ""
    @State private var showMemberPicker = false
    @State private var isSending = false
    @State private var pendingSession: Session?
    @State private var pendingSessionID: String?
    @State private var timeoutWork: DispatchWorkItem?
    @FocusState private var isInputFocused: Bool

    private var canSend: Bool {
        !isSending && !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            ZStack {
                VStack(spacing: 0) {
                    collaboratorsRow
                    Divider()
                    Spacer()
                    inputBar
                }

                if isSending {
                    Color.black.opacity(0.2)
                        .ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.large)
                        Text("等待 AI 响应...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(24)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .allowsHitTesting(!isSending)
        }
        .sheet(isPresented: $showMemberPicker) {
            UnifiedMemberSheet(
                mode: .select(
                    preSelected: Set(collaborators.map(\.id)),
                    onConfirm: { ids in
                        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
                        let allMembers = (try? modelContext.fetch(descriptor)) ?? []
                        collaborators = allMembers.filter { ids.contains($0.id) }
                    }
                ),
                mqttService: mqttService
            )
        }
        .interactiveDismissDisabled(isSending)
        .onAppear {
            isInputFocused = true
        }
        .onDisappear {
            timeoutWork?.cancel()
        }
        .onReceive(mqttService.receivedMessage.receive(on: DispatchQueue.main)) { msg in
            guard isSending, let pendingSessionID else { return }
            if case .chatResponse(let response) = msg.payload,
               response.sessionID == pendingSessionID {
                completeNavigation()
            }
        }
    }

    // MARK: - Collaborators row

    private var collaboratorsRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("协作者")
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(collaborators, id: \.id) { member in
                        CollaboratorChip(name: member.name) {
                            collaborators.removeAll { $0.id == member.id }
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
                    .foregroundStyle(.blue)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {} label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: 40, height: 40)
                    .liquidGlass(in: Circle())
            }

            HStack(alignment: .bottom, spacing: 4) {
                TextField("消息", text: $messageText, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...5)
                    .focused($isInputFocused)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .padding(.vertical, 10)

                if canSend {
                    Button(action: sendAndCreate) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(Color.green, in: Circle())
                    }
                    .padding(.trailing, 6)
                    .padding(.bottom, 6)
                }
            }
            .background(Color(.systemGray6), in: Capsule())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .padding(.bottom, 4)
    }

    // MARK: - Helpers

    private func sendAndCreate() {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let creds = PairingManager.currentCredentials else { return }

        let sessionID = UUID().uuidString
        let title = text.count > 40 ? String(text.prefix(40)) + "…" : text
        let session = Session(
            id: sessionID,
            title: title,
            agentName: collaborators.first?.name ?? "AI",
            lastMessageContent: text,
            lastMessageTime: Date(),
            isCollaborative: !collaborators.isEmpty,
            collaboratorIDs: collaborators.map(\.id)
        )
        modelContext.insert(session)

        // Create user ChatMessage locally so ChatDetailView finds it on load
        let userMessage = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .user,
            content: text,
            timestamp: Date()
        )
        modelContext.insert(userMessage)
        try? modelContext.save()

        isSending = true
        pendingSession = session
        pendingSessionID = sessionID
        isInputFocused = false

        // Send ChatRequest via MQTT (response handled by .onReceive)
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_ChatRequest()
        req.sessionID = sessionID
        req.content = text
        let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)

        // Timeout: navigate anyway after 30 seconds
        let work = DispatchWorkItem { [self] in
            if isSending { completeNavigation() }
        }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }

    private func completeNavigation() {
        guard isSending, let session = pendingSession else { return }
        timeoutWork?.cancel()
        timeoutWork = nil
        isSending = false
        pendingSession = nil
        pendingSessionID = nil
        onCreated(session)
        dismiss()
    }
}

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
        .background(Color(.systemGray5), in: Capsule())
        .foregroundStyle(.primary)
    }
}
