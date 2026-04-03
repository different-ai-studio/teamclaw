import Foundation
import Combine
import CocoaMQTT

final class MQTTService: NSObject, MQTTServiceProtocol {
    private var mqtt: CocoaMQTT5?
    private let connectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let messageSubject = PassthroughSubject<MQTTMessage, Never>()
    private let rawSubject = PassthroughSubject<(topic: String, payload: String), Never>()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    var isConnected: AnyPublisher<Bool, Never> { connectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<MQTTMessage, Never> { messageSubject.eraseToAnyPublisher() }
    var receivedRaw: AnyPublisher<(topic: String, payload: String), Never> { rawSubject.eraseToAnyPublisher() }

    func connect(host: String, port: UInt16, username: String, password: String) {
        let clientID = "teamclaw-ios-\(UUID().uuidString.prefix(8))"
        NSLog("[MQTTService] Connecting to \(host):\(port) as \(clientID)")
        NSLog("[MQTTService] Username: \(username), SSL enabled")

        let client = CocoaMQTT5(clientID: clientID, host: host, port: port)
        client.username = username
        client.password = password
        client.enableSSL = true
        client.allowUntrustCACertificate = true
        client.cleanSession = false
        client.keepAlive = 60
        client.autoReconnect = true
        client.autoReconnectTimeInterval = 5
        client.sslSettings = [
            kCFStreamSSLPeerName as String: host as NSString
        ]
        client.didReceiveTrust = { _, _, completionHandler in
            completionHandler(true)
        }
        client.delegate = self
        mqtt = client

        let result = client.connect()
        NSLog("[MQTTService] connect() returned: \(result)")
        if !result {
            NSLog("[MQTTService] Connection failed immediately - check host/port")
        }
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

    func publishRaw(topic: String, payload: String, qos: Int) {
        let mqttQoS: CocoaMQTTQoS = qos == 0 ? .qos0 : qos == 2 ? .qos2 : .qos1
        let properties = MqttPublishProperties()
        mqtt?.publish(topic, withString: payload, qos: mqttQoS, DUP: false, retained: false, properties: properties)
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
        NSLog("[MQTTService] didConnectAck: \(ack.rawValue) - \(ack)")
        if ack == .success {
            NSLog("[MQTTService] Connected successfully")
            connectedSubject.send(true)
        } else {
            NSLog("[MQTTService] Connection failed with reason: \(ack)")
            connectedSubject.send(false)
        }
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveMessage message: CocoaMQTT5Message, id: UInt16, publishData: MqttDecodePublish?) {
        guard let jsonString = message.string else { return }
        let topic = message.topic

        // Always emit raw for callers that need topic info (e.g. pairing)
        rawSubject.send((topic: topic, payload: jsonString))

        // Also try to decode as MQTTMessage envelope
        if let data = jsonString.data(using: .utf8),
           let mqttMessage = try? decoder.decode(MQTTMessage.self, from: data) {
            messageSubject.send(mqttMessage)
        }
    }

    func mqtt5DidDisconnect(_ mqtt5: CocoaMQTT5, withError err: Error?) {
        NSLog("[MQTTService] Disconnected, error: \(String(describing: err))")
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
