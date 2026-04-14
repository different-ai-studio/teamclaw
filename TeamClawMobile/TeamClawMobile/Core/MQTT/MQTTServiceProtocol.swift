import Combine
import Foundation

protocol MQTTServiceProtocol: AnyObject {
    var isConnected: AnyPublisher<Bool, Never> { get }
    var receivedMessage: AnyPublisher<Teamclaw_MqttMessage, Never> { get }
    var receivedData: AnyPublisher<(topic: String, data: Data), Never> { get }
    func connect(host: String, port: UInt16, username: String, password: String)
    func disconnect()
    func subscribe(topic: String, qos: Int)
    func unsubscribe(topic: String)
    func publish(topic: String, message: Teamclaw_MqttMessage, qos: Int)
}
