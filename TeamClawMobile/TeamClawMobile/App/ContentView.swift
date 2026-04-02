import SwiftUI

struct ContentView: View {
    @ObservedObject var pairingManager: PairingManager

    @StateObject private var connectionMonitor: ConnectionMonitor

    // Use MockMQTTService for development until broker exists
    private let mqttService: MQTTServiceProtocol

    init(pairingManager: PairingManager) {
        self.pairingManager = pairingManager
        let mqtt = MockMQTTService()
        self.mqttService = mqtt
        self._connectionMonitor = StateObject(wrappedValue: ConnectionMonitor(mqttService: mqtt))
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
    }
}
