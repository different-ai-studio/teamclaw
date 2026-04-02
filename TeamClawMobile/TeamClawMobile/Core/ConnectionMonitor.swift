import Combine
import Foundation

// MARK: - ConnectionMonitor

/// Observes MQTT status messages and publishes desktop online/offline state.
final class ConnectionMonitor: ObservableObject {

    // MARK: - Published Properties

    @Published var isDesktopOnline: Bool = false
    @Published var desktopDeviceName: String?

    // MARK: - Private

    private var cancellables = Set<AnyCancellable>()

    // MARK: - Init

    init(mqttService: MQTTServiceProtocol) {
        mqttService.receivedMessage
            .compactMap { message -> StatusPayload? in
                if case .status(let payload) = message.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] statusPayload in
                self?.isDesktopOnline = statusPayload.online
                self?.desktopDeviceName = statusPayload.deviceName
            }
            .store(in: &cancellables)
    }
}
