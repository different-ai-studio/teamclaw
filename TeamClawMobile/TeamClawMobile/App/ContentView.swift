import SwiftUI
import SwiftData

struct ContentView: View {
    @ObservedObject var pairingManager: PairingManager
    @Binding var pendingJoinURL: URL?
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var connectionMonitor = ConnectionMonitor(mqttService: MQTTService())
    @State private var hasRequestedInitialData = false

    var body: some View {
        Group {
            if let joinURL = pendingJoinURL {
                JoinTeamView(url: joinURL, pairingManager: pairingManager) {
                    pendingJoinURL = nil
                }
            } else if pairingManager.isAuthenticated {
                SessionListView(
                    mqttService: connectionMonitor.mqttService,
                    connectionMonitor: connectionMonitor,
                    pairingManager: pairingManager
                )
            } else {
                PairingView(pairingManager: pairingManager)
            }
        }
        .task {
            connectIfAuthenticated()
        }
        .onChange(of: connectionMonitor.isMQTTConnected) { _, connected in
            guard connected, let creds = pairingManager.credentials else { return }
            subscribeTopics(creds: creds)
            resubscribeCollabSessions(creds: creds)
            if !hasRequestedInitialData {
                hasRequestedInitialData = true
                requestInitialData(creds: creds)
            } else {
                // Reconnected after disconnect — do incremental sync
                requestInitialData(creds: creds)
            }
        }
        .onReceive(connectionMonitor.mqttService.receivedMessage.receive(on: DispatchQueue.main)) { mqttMessage in
            switch mqttMessage.payload {
            case .collabControl(let ctrl) where ctrl.type == .collabCreate:
                handleCollabCreate(ctrl)
            case .memberSyncResponse(let resp):
                handleMemberSync(resp)
            default:
                break
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, pairingManager.isAuthenticated else { return }
            if !connectionMonitor.isMQTTConnected {
                connectIfAuthenticated()
            }
        }
        .onChange(of: pairingManager.isPaired) { _, paired in
            if paired {
                hasRequestedInitialData = false
                connectIfAuthenticated()
            } else if !pairingManager.isLightweightUser {
                clearAllData()
                (connectionMonitor.mqttService as? MQTTService)?.disconnect()
            }
        }
        .onChange(of: pairingManager.isLightweightUser) { _, lightweight in
            if lightweight {
                hasRequestedInitialData = false
                connectIfAuthenticated()
            } else if !pairingManager.isPaired {
                clearAllData()
                (connectionMonitor.mqttService as? MQTTService)?.disconnect()
            }
        }
    }

    private func connectIfAuthenticated() {
        guard pairingManager.isAuthenticated,
              let creds = pairingManager.credentials,
              let mqtt = connectionMonitor.mqttService as? MQTTService else { return }
        mqtt.connect(
            host: creds.mqttHost,
            port: creds.mqttPort,
            username: creds.mqttUsername,
            password: creds.mqttPassword
        )
    }

    private func subscribeTopics(creds: PairingCredentials) {
        let mqtt = connectionMonitor.mqttService
        // Inbox topic — all authenticated users (paired and lightweight)
        mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/user/\(creds.deviceID)/inbox", qos: 1)
        if pairingManager.isPaired {
            // Paired users also subscribe to device-specific topics
            mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.desktopDeviceID)/status", qos: 1)
            mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/res", qos: 1)
            mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/task",     qos: 1)
            mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/skill",    qos: 1)
            mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/member",   qos: 1)
            mqtt.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/talent",   qos: 1)
        }
    }

    private func requestInitialData(creds: PairingCredentials) {
        let mqtt = connectionMonitor.mqttService
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"

        var sessionReq = Teamclaw_SessionSyncRequest()
        var pg1 = Teamclaw_PageRequest()
        pg1.page = 1; pg1.pageSize = 50
        sessionReq.pagination = pg1
        mqtt.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.sessionSyncRequest(sessionReq)), qos: 1)

        var memberReq = Teamclaw_MemberSyncRequest()
        var pg2 = Teamclaw_PageRequest()
        pg2.page = 1; pg2.pageSize = 50
        memberReq.pagination = pg2
        mqtt.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.memberSyncRequest(memberReq)), qos: 1)

        var autoReq = Teamclaw_AutomationSyncRequest()
        var pg3 = Teamclaw_PageRequest()
        pg3.page = 1; pg3.pageSize = 50
        autoReq.pagination = pg3
        mqtt.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.automationSyncRequest(autoReq)), qos: 1)
    }

    private func handleCollabCreate(_ ctrl: Teamclaw_CollabControl) {
        guard !ctrl.sessionID.isEmpty else { return }

        // Check if session already exists locally
        let sid = ctrl.sessionID
        let descriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.id == sid }
        )
        if let existing = try? modelContext.fetch(descriptor), !existing.isEmpty {
            // Already have it; just make sure we're subscribed
            if let creds = pairingManager.credentials {
                let sessionTopic = "teamclaw/\(creds.teamID)/session/\(sid)"
                connectionMonitor.mqttService.subscribe(topic: sessionTopic, qos: 1)
            }
            return
        }

        // Build collaborator IDs from proto members
        let collaboratorIDs = ctrl.members.map(\.nodeID)

        let session = Session(
            id: ctrl.sessionID,
            title: ctrl.senderName.isEmpty ? "协作会话" : "\(ctrl.senderName) 的协作",
            agentName: "AI 搭档",
            lastMessageContent: "",
            lastMessageTime: Date(),
            isCollaborative: true,
            collaboratorIDs: collaboratorIDs,
            ownerNodeId: ctrl.senderID,
            agentHostDevice: ctrl.hasAgentHostDevice ? ctrl.agentHostDevice : nil
        )
        modelContext.insert(session)
        try? modelContext.save()

        // Subscribe to the session topic
        if let creds = pairingManager.credentials {
            let sessionTopic = "teamclaw/\(creds.teamID)/session/\(ctrl.sessionID)"
            connectionMonitor.mqttService.subscribe(topic: sessionTopic, qos: 1)
        }
    }

    /// IDs received across all pages of the current member sync cycle.
    @State private var memberSyncReceivedIDs: Set<String> = []

    private func handleMemberSync(_ response: Teamclaw_MemberSyncResponse) {
        let pg = response.pagination
        guard !response.members.isEmpty || pg.total > 0 else { return }

        let isFirstPage = pg.page <= 1
        if isFirstPage { memberSyncReceivedIDs.removeAll() }

        for data in response.members {
            memberSyncReceivedIDs.insert(data.id)
            let member = TeamMember(
                id: data.id,
                name: data.name,
                avatarURL: data.avatarURL,
                department: data.hasDepartment ? data.department : "",
                isAIAlly: data.isAiAlly,
                note: data.note
            )
            modelContext.insert(member)
        }

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            // Request next page
            guard let creds = pairingManager.credentials else { return }
            let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
            var req = Teamclaw_MemberSyncRequest()
            var nextPg = Teamclaw_PageRequest()
            nextPg.page = pg.page + 1
            nextPg.pageSize = pg.pageSize
            req.pagination = nextPg
            connectionMonitor.mqttService.publish(
                topic: topic,
                message: ProtoMQTTCoder.makeEnvelope(.memberSyncRequest(req)),
                qos: 1
            )
        } else {
            // Remove stale members not present in this sync cycle
            let descriptor = FetchDescriptor<TeamMember>()
            if let existing = try? modelContext.fetch(descriptor) {
                for member in existing where !memberSyncReceivedIDs.contains(member.id) {
                    modelContext.delete(member)
                }
            }
        }
        try? modelContext.save()
    }

    private func resubscribeCollabSessions(creds: PairingCredentials) {
        let descriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.isCollaborative && !$0.isArchived }
        )
        guard let sessions = try? modelContext.fetch(descriptor) else { return }
        for session in sessions {
            let sessionTopic = "teamclaw/\(creds.teamID)/session/\(session.id)"
            connectionMonitor.mqttService.subscribe(topic: sessionTopic, qos: 1)
        }
    }

    private func clearAllData() {
        do {
            try modelContext.delete(model: Session.self)
            try modelContext.delete(model: ChatMessage.self)
            try modelContext.delete(model: TeamMember.self)
            try modelContext.delete(model: AutomationTask.self)
            try modelContext.delete(model: Skill.self)
            try modelContext.delete(model: Talent.self)
            try modelContext.save()
        } catch {
            print("[ContentView] Failed to clear data: \(error)")
        }
    }
}
