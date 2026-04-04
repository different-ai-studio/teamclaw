import Combine
import Foundation

final class ConnectionMonitor: ObservableObject {

    @Published var isDesktopOnline: Bool = false
    @Published var desktopDeviceName: String?

    private var cancellables = Set<AnyCancellable>()

    init(mqttService: MQTTServiceProtocol) {
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
