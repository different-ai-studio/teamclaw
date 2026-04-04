import Foundation
import Combine
import CocoaMQTT

final class MQTTService: NSObject, MQTTServiceProtocol {
    private var mqtt: CocoaMQTT5?
    private let connectedSubject = CurrentValueSubject<Bool, Never>(false)
    private let messageSubject = PassthroughSubject<Teamclaw_MqttMessage, Never>()
    private let dataSubject = PassthroughSubject<(topic: String, data: Data), Never>()

    var isConnected: AnyPublisher<Bool, Never> { connectedSubject.eraseToAnyPublisher() }
    var receivedMessage: AnyPublisher<Teamclaw_MqttMessage, Never> { messageSubject.eraseToAnyPublisher() }
    var receivedData: AnyPublisher<(topic: String, data: Data), Never> { dataSubject.eraseToAnyPublisher() }

    func connect(host: String, port: UInt16, username: String, password: String) {
        let clientID = "teamclaw-ios-\(UUID().uuidString.prefix(8))"
        let client = CocoaMQTT5(clientID: clientID, host: host, port: port)
        client.username = username
        client.password = password
        client.enableSSL = true
        client.allowUntrustCACertificate = true
        client.cleanSession = false
        client.keepAlive = 60
        client.autoReconnect = true
        client.autoReconnectTimeInterval = 5
        client.sslSettings = [kCFStreamSSLPeerName as String: host as NSString]
        client.didReceiveTrust = { _, _, completionHandler in completionHandler(true) }
        client.delegate = self
        mqtt = client
        _ = client.connect()
    }

    func disconnect() { mqtt?.disconnect() }

    func subscribe(topic: String, qos: Int) {
        let q: CocoaMQTTQoS = qos == 0 ? .qos0 : qos == 2 ? .qos2 : .qos1
        mqtt?.subscribe(topic, qos: q)
    }

    func publish(topic: String, message: Teamclaw_MqttMessage, qos: Int) {
        guard let data = ProtoMQTTCoder.encode(message) else { return }
        let q: CocoaMQTTQoS = qos == 0 ? .qos0 : qos == 2 ? .qos2 : .qos1
        let props = MqttPublishProperties()
        let message5 = CocoaMQTT5Message(topic: topic, payload: [UInt8](data))
        message5.qos = q
        mqtt?.publish(message5, DUP: false, retained: false, properties: props)
    }
}

extension MQTTService: CocoaMQTT5Delegate {
    func mqtt5(_ mqtt5: CocoaMQTT5, didConnectAck ack: CocoaMQTTCONNACKReasonCode, connAckData: MqttDecodeConnAck?) {
        connectedSubject.send(ack == .success)
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveMessage message: CocoaMQTT5Message, id: UInt16, publishData: MqttDecodePublish?) {
        let data = Data(message.payload)
        dataSubject.send((topic: message.topic, data: data))
        if let msg = ProtoMQTTCoder.decode(data) {
            messageSubject.send(msg)
        }
    }

    func mqtt5DidDisconnect(_ mqtt5: CocoaMQTT5, withError err: Error?) { connectedSubject.send(false) }
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
