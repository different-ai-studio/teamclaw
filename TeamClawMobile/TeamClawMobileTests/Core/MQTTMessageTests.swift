import XCTest
@testable import TeamClawMobile

final class MQTTMessageTests: XCTestCase {

    // MARK: - testDecodeChatResponse

    func testDecodeChatResponse() throws {
        let json = """
        {"id":"msg1","type":"chat_response","timestamp":1712000000,"payload":{"session_id":"s1","seq":0,"delta":"你好","done":false}}
        """
        let data = try XCTUnwrap(json.data(using: .utf8))
        let message = try JSONDecoder().decode(MQTTMessage.self, from: data)

        XCTAssertEqual(message.id, "msg1")
        XCTAssertEqual(message.type, .chatResponse)
        XCTAssertEqual(message.timestamp, 1712000000)

        guard case .chatResponse(let payload) = message.payload else {
            XCTFail("Expected chatResponse payload")
            return
        }
        XCTAssertEqual(payload.sessionID, "s1")
        XCTAssertEqual(payload.seq, 0)
        XCTAssertEqual(payload.delta, "你好")
        XCTAssertFalse(payload.done)
        XCTAssertNil(payload.full)
    }

    // MARK: - testDecodeFinalChatResponse

    func testDecodeFinalChatResponse() throws {
        let json = """
        {"id":"msg2","type":"chat_response","timestamp":1712000001,"payload":{"session_id":"s1","seq":5,"delta":"","done":true,"full":"你好，世界！"}}
        """
        let data = try XCTUnwrap(json.data(using: .utf8))
        let message = try JSONDecoder().decode(MQTTMessage.self, from: data)

        XCTAssertEqual(message.id, "msg2")
        XCTAssertEqual(message.type, .chatResponse)

        guard case .chatResponse(let payload) = message.payload else {
            XCTFail("Expected chatResponse payload")
            return
        }
        XCTAssertEqual(payload.sessionID, "s1")
        XCTAssertEqual(payload.seq, 5)
        XCTAssertEqual(payload.delta, "")
        XCTAssertTrue(payload.done)
        XCTAssertEqual(payload.full, "你好，世界！")
    }

    // MARK: - testDecodeStatusMessage

    func testDecodeStatusMessage() throws {
        let json = """
        {"id":"msg3","type":"status","timestamp":1712000002,"payload":{"online":true,"device_name":"iPhone 15 Pro"}}
        """
        let data = try XCTUnwrap(json.data(using: .utf8))
        let message = try JSONDecoder().decode(MQTTMessage.self, from: data)

        XCTAssertEqual(message.id, "msg3")
        XCTAssertEqual(message.type, .status)

        guard case .status(let payload) = message.payload else {
            XCTFail("Expected status payload")
            return
        }
        XCTAssertTrue(payload.online)
        XCTAssertEqual(payload.deviceName, "iPhone 15 Pro")
    }

    // MARK: - testEncodeChatRequest

    func testEncodeChatRequest() throws {
        let requestPayload = ChatRequestPayload(
            sessionID: "session-abc",
            content: "Hello!",
            imageURL: nil,
            model: "claude-3-5-sonnet"
        )
        let original = MQTTMessage(
            id: "req1",
            type: .chatRequest,
            timestamp: 1712000010,
            payload: .chatRequest(requestPayload)
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(original)

        let decoded = try JSONDecoder().decode(MQTTMessage.self, from: data)
        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.type, original.type)
        XCTAssertEqual(decoded.timestamp, original.timestamp)

        guard case .chatRequest(let payload) = decoded.payload else {
            XCTFail("Expected chatRequest payload")
            return
        }
        XCTAssertEqual(payload.sessionID, "session-abc")
        XCTAssertEqual(payload.content, "Hello!")
        XCTAssertNil(payload.imageURL)
        XCTAssertEqual(payload.model, "claude-3-5-sonnet")
    }

    // MARK: - testDecodeStatusOfflineNoDeviceName

    func testDecodeStatusOfflineNoDeviceName() throws {
        let json = """
        {"id":"msg4","type":"status","timestamp":1712000003,"payload":{"online":false}}
        """
        let data = try XCTUnwrap(json.data(using: .utf8))
        let message = try JSONDecoder().decode(MQTTMessage.self, from: data)

        guard case .status(let payload) = message.payload else {
            XCTFail("Expected status payload")
            return
        }
        XCTAssertFalse(payload.online)
        XCTAssertNil(payload.deviceName)
    }
}
