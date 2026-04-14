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
            if !hasRequestedInitialData {
                hasRequestedInitialData = true
                requestInitialData(creds: creds)
            } else {
                // Reconnected after disconnect — do incremental sync
                requestInitialData(creds: creds)
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
