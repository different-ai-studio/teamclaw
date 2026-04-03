import SwiftUI

struct ContentView: View {
    @ObservedObject var pairingManager: PairingManager

    @StateObject private var connectionMonitor: ConnectionMonitor

    private let mqttService: MQTTServiceProtocol

    init(pairingManager: PairingManager) {
        self.pairingManager = pairingManager
        let mqtt = MQTTService()
        self.mqttService = mqtt
        self._connectionMonitor = StateObject(wrappedValue: ConnectionMonitor(mqttService: mqtt))

        // Auto-connect if already paired (use shared credentials until broker user provisioning is implemented)
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
        }
        .onChange(of: pairingManager.isPaired) { _, paired in
            guard paired, let mqtt = mqttService as? MQTTService else { return }
            mqtt.connect(
                host: PairingManager.sharedHost,
                port: PairingManager.sharedPort,
                username: PairingManager.sharedUsername,
                password: PairingManager.sharedPassword
            )
        }
    }

    private func subscribeTopics(creds: PairingCredentials) {
        // Desktop status (retained — will arrive immediately)
        mqttService.subscribe(
            topic: "teamclaw/\(creds.teamID)/\(creds.desktopDeviceID)/status",
            qos: 1
        )
        // Chat responses to this mobile device
        mqttService.subscribe(
            topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/res",
            qos: 1
        )
        // Task / skill / member sync
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/task",   qos: 1)
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/skill",  qos: 1)
        mqttService.subscribe(topic: "teamclaw/\(creds.teamID)/\(creds.deviceID)/member", qos: 1)
    }
}
