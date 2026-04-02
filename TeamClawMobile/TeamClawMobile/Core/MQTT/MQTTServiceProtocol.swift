import Combine
import Foundation

protocol MQTTServiceProtocol: AnyObject {
    var isConnected: AnyPublisher<Bool, Never> { get }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { get }
    func connect(host: String, port: UInt16, username: String, password: String)
    func disconnect()
    func subscribe(topic: String, qos: Int)
    func publish(topic: String, message: MQTTMessage, qos: Int)
}
