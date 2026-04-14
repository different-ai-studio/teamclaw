import XCTest
@testable import TeamClawMobile

final class CollabProtoTests: XCTestCase {

    func testChatRequestWithSenderFields() throws {
        var req = Teamclaw_ChatRequest()
        req.sessionID = "sess-1"
        req.content = "hello"
        req.senderID = "node-123"
        req.senderName = "张三"
        req.senderType = "human"

        let envelope = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(envelope))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .chatRequest(let decodedReq) = decoded.payload else {
            XCTFail("Expected chatRequest"); return
        }
        XCTAssertEqual(decodedReq.senderID, "node-123")
        XCTAssertEqual(decodedReq.senderName, "张三")
        XCTAssertEqual(decodedReq.senderType, "human")
    }

    func testCollabControlCreateRoundTrips() throws {
        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabCreate
        ctrl.senderID = "creator-1"
        ctrl.senderName = "Alice"
        ctrl.sessionID = "collab-session-1"
        ctrl.agentHostDevice = "desktop-abc"

        var member1 = Teamclaw_CollabMember()
        member1.nodeID = "node-1"
        member1.name = "Alice"
        var member2 = Teamclaw_CollabMember()
        member2.nodeID = "node-2"
        member2.name = "Bob"
        ctrl.members = [member1, member2]

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(envelope))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .collabControl(let d) = decoded.payload else {
            XCTFail("Expected collabControl"); return
        }
        XCTAssertEqual(d.type, .collabCreate)
        XCTAssertEqual(d.sessionID, "collab-session-1")
        XCTAssertEqual(d.agentHostDevice, "desktop-abc")
        XCTAssertEqual(d.members.count, 2)
        XCTAssertEqual(d.members[0].name, "Alice")
        XCTAssertEqual(d.members[1].name, "Bob")
    }

    func testCollabControlLeaveRoundTrips() throws {
        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabLeave
        ctrl.senderID = "user-1"
        ctrl.senderName = "Bob"
        ctrl.sessionID = "collab-1"

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(envelope))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .collabControl(let d) = decoded.payload else {
            XCTFail("Expected collabControl"); return
        }
        XCTAssertEqual(d.type, .collabLeave)
        XCTAssertEqual(d.senderName, "Bob")
        XCTAssertEqual(d.sessionID, "collab-1")
    }

    func testCollabControlEndRoundTrips() throws {
        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabEnd
        ctrl.senderID = "owner"
        ctrl.sessionID = "collab-1"

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(envelope))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .collabControl(let d) = decoded.payload else {
            XCTFail("Expected collabControl"); return
        }
        XCTAssertEqual(d.type, .collabEnd)
        XCTAssertEqual(d.senderID, "owner")
    }

    func testChatMessageDataWithSenderFields() {
        var msgData = Teamclaw_ChatMessageData()
        msgData.id = "msg-1"
        msgData.role = "user"
        msgData.content = "hello"
        msgData.timestamp = Date().timeIntervalSince1970
        msgData.senderID = "user-abc"
        msgData.senderName = "小明"

        XCTAssertTrue(msgData.hasSenderID)
        XCTAssertTrue(msgData.hasSenderName)
        XCTAssertEqual(msgData.senderID, "user-abc")
        XCTAssertEqual(msgData.senderName, "小明")
    }

    func testCollabMemberFields() throws {
        var member = Teamclaw_CollabMember()
        member.nodeID = "node-abc"
        member.name = "Carol"

        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabCreate
        ctrl.senderID = "node-abc"
        ctrl.sessionID = "sess-x"
        ctrl.members = [member]

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl))
        let data = try XCTUnwrap(ProtoMQTTCoder.encode(envelope))
        let decoded = try XCTUnwrap(ProtoMQTTCoder.decode(data))

        guard case .collabControl(let d) = decoded.payload else {
            XCTFail("Expected collabControl"); return
        }
        XCTAssertEqual(d.members.count, 1)
        XCTAssertEqual(d.members[0].nodeID, "node-abc")
        XCTAssertEqual(d.members[0].name, "Carol")
    }
}
