import Combine
import Foundation

final class MockMQTTService: MQTTServiceProtocol {

    // MARK: - Subjects

    private let isConnectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let receivedMessageSubject = PassthroughSubject<MQTTMessage, Never>()

    // MARK: - MQTTServiceProtocol

    var isConnected: AnyPublisher<Bool, Never> {
        isConnectedSubject.eraseToAnyPublisher()
    }

    var receivedMessage: AnyPublisher<MQTTMessage, Never> {
        receivedMessageSubject.eraseToAnyPublisher()
    }

    // MARK: - Recorded Calls (for assertions in tests)

    private(set) var connectCalls: [(host: String, port: UInt16, username: String, password: String)] = []
    private(set) var disconnectCallCount = 0
    private(set) var subscribeCalls: [(topic: String, qos: Int)] = []
    private(set) var publishCalls: [(topic: String, message: MQTTMessage, qos: Int)] = []

    // MARK: - Protocol Methods

    func connect(host: String, port: UInt16, username: String, password: String) {
        connectCalls.append((host: host, port: port, username: username, password: password))
        isConnectedSubject.send(true)
    }

    func disconnect() {
        disconnectCallCount += 1
        isConnectedSubject.send(false)
    }

    func subscribe(topic: String, qos: Int) {
        subscribeCalls.append((topic: topic, qos: qos))
    }

    func publish(topic: String, message: MQTTMessage, qos: Int) {
        publishCalls.append((topic: topic, message: message, qos: qos))
    }

    // MARK: - Test Helpers

    /// Simulate receiving an inbound MQTT message.
    func simulateMessage(_ message: MQTTMessage) {
        receivedMessageSubject.send(message)
    }

    /// Simulate a sudden connection drop (without going through `disconnect()`).
    func simulateDisconnect() {
        isConnectedSubject.send(false)
    }
}
