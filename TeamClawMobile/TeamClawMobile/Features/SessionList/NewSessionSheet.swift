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
    @FocusState private var isInputFocused: Bool

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                }
            }
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
        .onAppear {
            isInputFocused = true
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

        let isCollab = !collaborators.isEmpty
        let sessionID = UUID().uuidString
        let title = text.count > 40 ? String(text.prefix(40)) + "…" : text

        var collaboratorIDs = collaborators.map(\.id)
        if isCollab && !collaboratorIDs.contains(creds.deviceID) {
            collaboratorIDs.append(creds.deviceID)
        }

        let session = Session(
            id: sessionID,
            title: title,
            agentName: collaborators.first?.name ?? "AI",
            lastMessageContent: text,
            lastMessageTime: Date(),
            isCollaborative: isCollab,
            collaboratorIDs: collaboratorIDs,
            ownerNodeId: isCollab ? creds.deviceID : nil,
            agentHostDevice: isCollab ? creds.desktopDeviceID : nil
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

        isInputFocused = false

        // For collaborative sessions, send CollabControl CREATE first
        if isCollab {
            let username = UserDefaults.standard.string(forKey: "teamclaw_username") ?? ""

            var control = Teamclaw_CollabControl()
            control.type = .collabCreate
            control.senderID = creds.deviceID
            control.senderName = username
            control.sessionID = sessionID
            control.agentHostDevice = creds.desktopDeviceID

            for collab in collaborators {
                var member = Teamclaw_CollabMember()
                member.nodeID = collab.id
                member.name = collab.name
                control.members.append(member)
            }
            var selfMember = Teamclaw_CollabMember()
            selfMember.nodeID = creds.deviceID
            selfMember.name = username
            control.members.append(selfMember)

            let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(control))

            // Send to desktop via the chat/req topic it actually listens on
            let reqTopic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
            mqttService.publish(topic: reqTopic, message: envelope, qos: 1)

            // Notify each collaborator via their inbox
            for collab in collaborators {
                let inboxTopic = "teamclaw/\(creds.teamID)/user/\(collab.id)/inbox"
                mqttService.publish(topic: inboxTopic, message: envelope, qos: 1)
            }

            // Subscribe to the session topic
            let sessionTopic = "teamclaw/\(creds.teamID)/session/\(sessionID)"
            mqttService.subscribe(topic: sessionTopic, qos: 1)
        }

        // Send ChatRequest via MQTT
        let chatTopic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        // For collab sessions, delay to let desktop process CollabControl CREATE first
        if isCollab {
            let svc = mqttService
            let sid = sessionID
            let txt = text
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                var req = Teamclaw_ChatRequest()
                req.sessionID = sid
                req.content = txt
                svc.publish(topic: chatTopic, message: ProtoMQTTCoder.makeEnvelope(.chatRequest(req)), qos: 1)
            }
        } else {
            var req = Teamclaw_ChatRequest()
            req.sessionID = sessionID
            req.content = text
            mqttService.publish(topic: chatTopic, message: ProtoMQTTCoder.makeEnvelope(.chatRequest(req)), qos: 1)
        }

        // Navigate immediately — AI response will stream into ChatDetailView
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
