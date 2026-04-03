import Combine
import Foundation

protocol MQTTServiceProtocol: AnyObject {
    var isConnected: AnyPublisher<Bool, Never> { get }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { get }
    /// Raw (topic, jsonString) for messages that don't conform to MQTTMessage envelope
    var receivedRaw: AnyPublisher<(topic: String, payload: String), Never> { get }
    func connect(host: String, port: UInt16, username: String, password: String)
    func disconnect()
    func subscribe(topic: String, qos: Int)
    func publishRaw(topic: String, payload: String, qos: Int)
    func publish(topic: String, message: MQTTMessage, qos: Int)
}
