import Combine
import Foundation

final class ConnectionMonitor: ObservableObject {

    enum ConnectionState: Equatable {
        case disconnected
        case reconnecting
        case connected
    }

    @Published var isDesktopOnline: Bool = false
    @Published var isMQTTConnected: Bool = false
    @Published var connectionState: ConnectionState = .disconnected
    @Published var desktopDeviceName: String?

    /// Stable MQTTService instance — lives as long as this @StateObject.
    let mqttService: MQTTServiceProtocol

    /// Whether we have connected at least once this session.
    private var hasConnectedBefore = false
    private var cancellables = Set<AnyCancellable>()

    init(mqttService: MQTTServiceProtocol) {
        self.mqttService = mqttService

        mqttService.isConnected
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] connected in
                guard let self else { return }
                self.isMQTTConnected = connected
                if connected {
                    self.connectionState = .connected
                    self.hasConnectedBefore = true
                } else if self.hasConnectedBefore {
                    // Was connected before → now reconnecting
                    self.connectionState = .reconnecting
                } else {
                    self.connectionState = .disconnected
                }
            }
            .store(in: &cancellables)

        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_StatusReport? in
                if case .statusReport(let status) = msg.payload { return status }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.isDesktopOnline = status.online
                if status.hasDeviceName {
                    self?.desktopDeviceName = status.deviceName
                }
            }
            .store(in: &cancellables)
    }
}
