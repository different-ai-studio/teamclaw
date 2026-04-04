import Foundation
import SwiftProtobuf

enum ProtoMQTTCoder {

    static func encode(_ message: Teamclaw_MqttMessage) -> Data? {
        try? message.serializedData()
    }

    static func decode(_ data: Data) -> Teamclaw_MqttMessage? {
        try? Teamclaw_MqttMessage(serializedBytes: data)
    }

    static func makeEnvelope(_ payload: Teamclaw_MqttMessage.OneOf_Payload) -> Teamclaw_MqttMessage {
        var msg = Teamclaw_MqttMessage()
        msg.id = UUID().uuidString
        msg.timestamp = Date().timeIntervalSince1970
        msg.payload = payload
        return msg
    }
}
