import SwiftUI
import SwiftData

struct ContentView: View {
    @ObservedObject var pairingManager: PairingManager
    @Environment(\.modelContext) private var modelContext

    @StateObject private var connectionMonitor: ConnectionMonitor

    private let mqttService: MQTTServiceProtocol

    init(pairingManager: PairingManager) {
        self.pairingManager = pairingManager
        let mqtt = MQTTService()
        self.mqttService = mqtt
        self._connectionMonitor = StateObject(wrappedValue: ConnectionMonitor(mqttService: mqtt))

        if pairingManager.isPaired {
            mqtt.connect(
                host: PairingManager.sharedHost,
                port: PairingManager.sharedPort,
                username: PairingManager.sharedUsername,
                password: PairingManager.sharedPassword
            )
        }
    }

    var body: some View {
        Group {
            if pairingManager.isPaired {
                SessionListView(
                    mqttService: mqttService,
                    connectionMonitor: connectionMonitor,
                    pairingManager: pairingManager
                )
            } else {
                PairingView(pairingManager: pairingManager)
            }
        }
        .onReceive(mqttService.isConnected) { connected in
            guard connected, let creds = pairingManager.credentials else { return }
            subscribeTopics(creds: creds)
            requestInitialData(creds: creds)
        }
        .onChange(of: pairingManager.isPaired) { _, paired in
            if paired {
                guard let mqtt = mqttService as? MQTTService else { return }
                mqtt.connect(
                    host: PairingManager.sharedHost,
                    port: PairingManager.sharedPort,
                    username: PairingManager.sharedUsername,
                    password: PairingManager.sharedPassword
                )
            } else {
                // Unpaired — clear all cached data
                clearAllData()
                (mqttService as? MQTTService)?.disconnect()
            }
        }
    }

    private func subscribeTopics(creds: PairingCredentials) {
        mqttService.subscribe(
            topic: "teamclaw/\(creds.teamID)/\(creds.desktopDeviceID)/status",
            qos: 1
        )
        mqttService.subscribe(
            topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/res",
            qos: 1
        )
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/task",   qos: 1)
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/skill",  qos: 1)
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/member", qos: 1)
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/talent", qos: 1)
    }

    /// Request initial data after MQTT connection is established.
    private func requestInitialData(creds: PairingCredentials) {
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"

        // Sessions
        var sessionReq = Teamclaw_SessionSyncRequest()
        var pg1 = Teamclaw_PageRequest()
        pg1.page = 1; pg1.pageSize = 50
        sessionReq.pagination = pg1
        mqttService.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.sessionSyncRequest(sessionReq)), qos: 1)

        // Members
        var memberReq = Teamclaw_MemberSyncRequest()
        var pg2 = Teamclaw_PageRequest()
        pg2.page = 1; pg2.pageSize = 50
        memberReq.pagination = pg2
        mqttService.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.memberSyncRequest(memberReq)), qos: 1)

        // Automations
        var autoReq = Teamclaw_AutomationSyncRequest()
        var pg3 = Teamclaw_PageRequest()
        pg3.page = 1; pg3.pageSize = 50
        autoReq.pagination = pg3
        mqttService.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.automationSyncRequest(autoReq)), qos: 1)
    }

    /// Clear all SwiftData when unpairing.
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
