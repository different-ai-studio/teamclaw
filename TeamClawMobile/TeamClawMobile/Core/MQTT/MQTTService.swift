import Foundation
import Combine
import CocoaMQTT

final class MQTTService: NSObject, MQTTServiceProtocol {
    private var mqtt: CocoaMQTT5?
    private let connectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let messageSubject = PassthroughSubject<MQTTMessage, Never>()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    var isConnected: AnyPublisher<Bool, Never> { connectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { messageSubject.eraseToAnyPublisher() }

    func connect(host: String, port: UInt16, username: String, password: String) {
        let clientID = "teamclaw-ios-\(UUID().uuidString.prefix(8))"
        let client = CocoaMQTT5(clientID: clientID, host: host, port: port)
        client.username = username
        client.password = password
        client.enableSSL = true
        client.cleanSession = false
        client.keepAlive = 60
        client.autoReconnect = true
        client.autoReconnectTimeInterval = 5
        client.delegate = self
        mqtt = client
        _ = client.connect()
    }

    func disconnect() {
        mqtt?.disconnect()
    }

    func subscribe(topic: String, qos: Int) {
        let mqttQoS: CocoaMQTTQoS
        switch qos {
        case 0: mqttQoS = .qos0
        case 2: mqttQoS = .qos2
        default: mqttQoS = .qos1
        }
        mqtt?.subscribe(topic, qos: mqttQoS)
    }

    func publish(topic: String, message: MQTTMessage, qos: Int) {
        guard let data = try? encoder.encode(message),
              let jsonString = String(data: data, encoding: .utf8) else { return }
        let mqttQoS: CocoaMQTTQoS
        switch qos {
        case 0: mqttQoS = .qos0
        case 2: mqttQoS = .qos2
        default: mqttQoS = .qos1
        }
        let properties = MqttPublishProperties()
        mqtt?.publish(topic, withString: jsonString, qos: mqttQoS, DUP: false, retained: false, properties: properties)
    }
}

// MARK: - CocoaMQTT5Delegate

extension MQTTService: CocoaMQTT5Delegate {

    func mqtt5(_ mqtt5: CocoaMQTT5, didConnectAck ack: CocoaMQTTCONNACKReasonCode, connAckData: MqttDecodeConnAck?) {
        if ack == .success {
            connectedSubject.send(true)
        }
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveMessage message: CocoaMQTT5Message, id: UInt16, publishData: MqttDecodePublish?) {
        guard let jsonString = message.string,
              let data = jsonString.data(using: .utf8),
              let mqttMessage = try? decoder.decode(MQTTMessage.self, from: data) else { return }
        messageSubject.send(mqttMessage)
    }

    func mqtt5DidDisconnect(_ mqtt5: CocoaMQTT5, withError err: Error?) {
        connectedSubject.send(false)
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishMessage message: CocoaMQTT5Message, id: UInt16) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishAck id: UInt16, pubAckData: MqttDecodePubAck?) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishRec id: UInt16, pubRecData: MqttDecodePubRec?) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didSubscribeTopics success: NSDictionary, failed: [String], subAckData: MqttDecodeSubAck?) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didUnsubscribeTopics topics: [String], unsubAckData: MqttDecodeUnsubAck?) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveDisconnectReasonCode reasonCode: CocoaMQTTDISCONNECTReasonCode) {}

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveAuthReasonCode reasonCode: CocoaMQTTAUTHReasonCode) {}

    func mqtt5DidPing(_ mqtt5: CocoaMQTT5) {}

    func mqtt5DidReceivePong(_ mqtt5: CocoaMQTT5) {}
}
