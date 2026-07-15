import Foundation
import SwiftProtobuf

public struct ProtoMQTTCoder {
    public static func decode<T: SwiftProtobuf.Message>(_ type: T.Type, from data: Data) throws -> T {
        try T(serializedBytes: data)
    }

    public static func encode(_ message: SwiftProtobuf.Message) throws -> Data {
        try message.serializedData()
    }
}
