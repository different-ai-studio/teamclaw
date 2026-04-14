import Combine
import Foundation

final class MockMQTTService: MQTTServiceProtocol {
    private let isConnectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let receivedMessageSubject = PassthroughSubject<Teamclaw_MqttMessage, Never>()
    private let receivedDataSubject = PassthroughSubject<(topic: String, data: Data), Never>()

    var isConnected: AnyPublisher<Bool, Never> { isConnectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<Teamclaw_MqttMessage, Never> { receivedMessageSubject.eraseToAnyPublisher() }
    var receivedData: AnyPublisher<(topic: String, data: Data), Never> { receivedDataSubject.eraseToAnyPublisher() }

    private(set) var connectCalls: [(host: String, port: UInt16, username: String, password: String)] = []
    private(set) var disconnectCallCount = 0
    private(set) var subscribeCalls: [(topic: String, qos: Int)] = []
    private(set) var publishCalls: [(topic: String, message: Teamclaw_MqttMessage, qos: Int)] = []

    func connect(host: String, port: UInt16, username: String, password: String) {
        connectCalls.append((host, port, username, password))
        isConnectedSubject.send(true)
    }

    func disconnect() {
        disconnectCallCount += 1
        isConnectedSubject.send(false)
    }

    func subscribe(topic: String, qos: Int) {
        subscribeCalls.append((topic, qos))
    }

    func unsubscribe(topic: String) {}

    func publish(topic: String, message: Teamclaw_MqttMessage, qos: Int) {
        publishCalls.append((topic, message, qos))
    }

    func simulateMessage(_ message: Teamclaw_MqttMessage) {
        receivedMessageSubject.send(message)
    }

    func simulateDisconnect() {
        isConnectedSubject.send(false)
    }
}
