import XCTest
@testable import TeamClawMobile

final class MQTTMessageTests: XCTestCase {

    func testChatRequestRoundTrip() throws {
        var req = Teamclaw_ChatRequest()
        req.sessionID = "s1"
        req.content = "Hello"
        req.model = "claude-3-5-sonnet"

        let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatRequest(let payload) = decoded.payload else {
            XCTFail("Expected chatRequest")
            return
        }
        XCTAssertEqual(payload.sessionID, "s1")
        XCTAssertEqual(payload.content, "Hello")
        XCTAssertEqual(payload.model, "claude-3-5-sonnet")
    }

    func testChatResponseDelta() throws {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "s1"
        resp.seq = 0
        resp.event = .delta("你好")

        let msg = ProtoMQTTCoder.makeEnvelope(.chatResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatResponse(let payload) = decoded.payload else {
            XCTFail("Expected chatResponse")
            return
        }
        XCTAssertEqual(payload.sessionID, "s1")
        XCTAssertEqual(payload.seq, 0)
        guard case .delta(let text) = payload.event else {
            XCTFail("Expected delta event")
            return
        }
        XCTAssertEqual(text, "你好")
    }

    func testChatResponseDone() throws {
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "s1"
        resp.seq = 5
        resp.event = .done(Teamclaw_StreamDone())

        let msg = ProtoMQTTCoder.makeEnvelope(.chatResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatResponse(let payload) = decoded.payload else {
            XCTFail("Expected chatResponse")
            return
        }
        guard case .done = payload.event else {
            XCTFail("Expected done event")
            return
        }
    }

    func testChatResponseError() throws {
        var err = Teamclaw_StreamError()
        err.message = "rate limited"
        var resp = Teamclaw_ChatResponse()
        resp.sessionID = "s1"
        resp.seq = 3
        resp.event = .error(err)

        let msg = ProtoMQTTCoder.makeEnvelope(.chatResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatResponse(let payload) = decoded.payload,
              case .error(let streamErr) = payload.event else {
            XCTFail("Expected error event")
            return
        }
        XCTAssertEqual(streamErr.message, "rate limited")
    }

    func testMemberSyncWithPagination() throws {
        var member = Teamclaw_MemberData()
        member.id = "m1"
        member.name = "Alice"
        member.avatarUrl = "https://example.com/a.png"
        member.isAiAlly = false
        member.note = ""

        var pageInfo = Teamclaw_PageInfo()
        pageInfo.page = 1
        pageInfo.pageSize = 50
        pageInfo.total = 1

        var resp = Teamclaw_MemberSyncResponse()
        resp.members = [member]
        resp.pagination = pageInfo

        let msg = ProtoMQTTCoder.makeEnvelope(.memberSyncResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .memberSyncResponse(let payload) = decoded.payload else {
            XCTFail("Expected memberSyncResponse")
            return
        }
        XCTAssertEqual(payload.members.count, 1)
        XCTAssertEqual(payload.members[0].name, "Alice")
        XCTAssertEqual(payload.pagination.total, 1)
    }

    func testStatusReport() throws {
        var status = Teamclaw_StatusReport()
        status.online = true
        status.deviceName = "MacBook Pro"

        let msg = ProtoMQTTCoder.makeEnvelope(.statusReport(status))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .statusReport(let payload) = decoded.payload else {
            XCTFail("Expected statusReport")
            return
        }
        XCTAssertTrue(payload.online)
        XCTAssertEqual(payload.deviceName, "MacBook Pro")
    }

    func testPairingResponseRoundTrip() throws {
        var resp = Teamclaw_PairingResponse()
        resp.mqttHost = "broker.example.com"
        resp.mqttPort = 8883
        resp.mqttUsername = "mobile_abc"
        resp.mqttPassword = "secret"
        resp.teamID = "team-1"
        resp.desktopDeviceID = "desktop-1"
        resp.desktopDeviceName = "MacBook"

        let msg = ProtoMQTTCoder.makeEnvelope(.pairingResponse(resp))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(msg))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .pairingResponse(let payload) = decoded.payload else {
            XCTFail("Expected pairingResponse")
            return
        }
        XCTAssertEqual(payload.mqttHost, "broker.example.com")
        XCTAssertEqual(payload.mqttPort, 8883)
        XCTAssertEqual(payload.teamID, "team-1")
    }
}
