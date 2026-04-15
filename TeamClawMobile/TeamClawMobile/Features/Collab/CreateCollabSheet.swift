import SwiftUI
import SwiftData

// MARK: - CreateCollabSheet

struct CreateCollabSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let mqttService: MQTTServiceProtocol
    let onCreated: (Session) -> Void

    @State private var showMemberPicker = false
    @State private var selectedMemberIDs: Set<String> = []
    @State private var selectedMembers: [TeamMember] = []
    @State private var sessionTitle: String = ""
    @FocusState private var isTitleFocused: Bool

    private var canCreate: Bool {
        !selectedMemberIDs.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("会话标题（可选）") {
                    TextField("协作会话", text: $sessionTitle)
                        .focused($isTitleFocused)
                }

                Section("成员") {
                    if selectedMembers.isEmpty {
                        Button {
                            showMemberPicker = true
                        } label: {
                            Label("选择协作成员", systemImage: "person.badge.plus")
                        }
                    } else {
                        ForEach(selectedMembers, id: \.id) { member in
                            HStack(spacing: 10) {
                                ZStack {
                                    Circle()
                                        .fill(member.isAIAlly ? Color.blue.opacity(0.2) : Color.purple.opacity(0.2))
                                        .frame(width: 32, height: 32)
                                    if member.isAIAlly {
                                        Image(systemName: "cpu")
                                            .font(.subheadline)
                                            .foregroundStyle(.blue)
                                    } else {
                                        Text(String(member.name.prefix(1)))
                                            .font(.subheadline)
                                            .foregroundStyle(.purple)
                                    }
                                }
                                Text(member.name)
                            }
                        }
                        Button {
                            showMemberPicker = true
                        } label: {
                            Label("修改成员", systemImage: "pencil")
                        }
                    }
                }
            }
            .navigationTitle("新建协作")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") {
                        createCollabSession()
                    }
                    .disabled(!canCreate)
                    .fontWeight(.semibold)
                }
            }
            .sheet(isPresented: $showMemberPicker) {
                UnifiedMemberSheet(
                    mode: .select(
                        preSelected: selectedMemberIDs,
                        onConfirm: { ids in
                            selectedMemberIDs = ids
                            let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
                            let allMembers = (try? modelContext.fetch(descriptor)) ?? []
                            selectedMembers = allMembers.filter { ids.contains($0.id) }
                        }
                    ),
                    mqttService: mqttService
                )
            }
            .onAppear {
                isTitleFocused = false
            }
        }
    }

    // MARK: - Create

    private func createCollabSession() {
        guard let creds = PairingManager.currentCredentials else { return }

        let sessionID = UUID().uuidString
        let title = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTitle = title.isEmpty ? "协作会话" : title

        // Build collaborator IDs: our own deviceID + selected members
        var collaboratorIDs = Array(selectedMemberIDs)
        if !collaboratorIDs.contains(creds.deviceID) {
            collaboratorIDs.append(creds.deviceID)
        }

        let session = Session(
            id: sessionID,
            title: finalTitle,
            agentName: "AI 搭档",
            lastMessageContent: "",
            lastMessageTime: Date(),
            isCollaborative: true,
            collaboratorIDs: collaboratorIDs,
            ownerNodeId: creds.deviceID,
            agentHostDevice: creds.desktopDeviceID
        )
        modelContext.insert(session)
        try? modelContext.save()

        // Build CollabControl CREATE message
        var control = Teamclaw_CollabControl()
        control.type = .collabCreate
        control.senderID = creds.deviceID
        control.senderName = pairingManagerUsername()
        control.sessionID = sessionID
        control.agentHostDevice = creds.desktopDeviceID

        // Add all members to the proto
        for memberID in selectedMemberIDs {
            var member = Teamclaw_CollabMember()
            member.nodeID = memberID
            if let tm = selectedMembers.first(where: { $0.id == memberID }) {
                member.name = tm.name
            }
            control.members.append(member)
        }
        // Add ourselves
        var selfMember = Teamclaw_CollabMember()
        selfMember.nodeID = creds.deviceID
        selfMember.name = pairingManagerUsername()
        control.members.append(selfMember)

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(control))

        // Send to desktop via the chat/req topic it actually listens on
        let reqTopic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        mqttService.publish(topic: reqTopic, message: envelope, qos: 1)

        // Notify each collaborator via their inbox
        for memberID in selectedMemberIDs {
            let inboxTopic = "teamclaw/\(creds.teamID)/user/\(memberID)/inbox"
            mqttService.publish(topic: inboxTopic, message: envelope, qos: 1)
        }

        // Subscribe to the session topic
        let sessionTopic = "teamclaw/\(creds.teamID)/session/\(sessionID)"
        mqttService.subscribe(topic: sessionTopic, qos: 1)

        onCreated(session)
        dismiss()
    }

    // MARK: - Helpers

    private func pairingManagerUsername() -> String {
        UserDefaults.standard.string(forKey: "teamclaw_username") ?? ""
    }
}
