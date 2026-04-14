import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class CollabChatViewModelTests: XCTestCase {
    var mockMQTT: MockMQTTService!
    var modelContext: ModelContext!
    var container: ModelContainer!

    override func setUp() {
        super.setUp()
        mockMQTT = MockMQTTService()
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self,
            configurations: config
        )
        modelContext = container.mainContext
    }

    override func tearDown() {
        clearFakeCredentials()
        modelContext = nil
        container = nil
        mockMQTT = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeSession(id: String = "collab-1", ownerNodeId: String = "my-node") -> Session {
        let session = Session(
            id: id, title: "Test Collab", agentName: "Agent",
            lastMessageContent: "", lastMessageTime: Date(),
            isCollaborative: true, collaboratorIDs: ["user2"],
            ownerNodeId: ownerNodeId, agentHostDevice: "desktop-1"
        )
        modelContext.insert(session)
        return session
    }

    private func makeVM(session: Session) -> CollabChatViewModel {
        let vm = CollabChatViewModel(session: session, mqttService: mockMQTT)
        vm.setModelContext(modelContext)
        return vm
    }

    // MARK: - Send message

    func testSendMessageCreatesLocalMessageAndPublishes() {
        setFakeCredentials()
        let session = makeSession()
        let vm = makeVM(session: session)

        vm.inputText = "hello team"
        vm.sendMessage()

        XCTAssertEqual(vm.messages.count, 1)
        XCTAssertEqual(vm.messages[0].role, .user)
        XCTAssertEqual(vm.messages[0].content, "hello team")
        XCTAssertTrue(vm.inputText.isEmpty)

        XCTAssertEqual(mockMQTT.publishCalls.count, 1)
        let published = mockMQTT.publishCalls[0]
        XCTAssertTrue(published.topic.contains("session/collab-1"))
        guard case .chatRequest(let req) = published.message.payload else {
            XCTFail("Expected chatRequest"); return
        }
        XCTAssertEqual(req.content, "hello team")
        XCTAssertEqual(req.senderType, "human")
    }

    func testSendMessageIgnoresEmptyInput() {
        setFakeCredentials()
        let session = makeSession()
        let vm = makeVM(session: session)
        vm.inputText = "   "
        vm.sendMessage()
        XCTAssertEqual(vm.messages.count, 0)
        XCTAssertEqual(mockMQTT.publishCalls.count, 0)
    }

    // MARK: - Receive collaborator message

    func testReceiveCollaboratorMessage() {
        setFakeCredentials()
        let session = makeSession()
        let vm = makeVM(session: session)

        var req = Teamclaw_ChatRequest()
        req.sessionID = "collab-1"
        req.content = "hey everyone"
        req.senderID = "other-user"
        req.senderName = "小红"
        req.senderType = "human"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.chatRequest(req)))

        let exp = expectation(description: "message received")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.messages.count, 1)
            XCTAssertEqual(vm.messages[0].role, .collaborator)
            XCTAssertEqual(vm.messages[0].senderName, "小红")
            XCTAssertEqual(vm.messages[0].content, "hey everyone")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - Receive Agent reply

    func testReceiveAgentReply() {
        setFakeCredentials()
        let session = makeSession()
        let vm = makeVM(session: session)

        var req = Teamclaw_ChatRequest()
        req.sessionID = "collab-1"
        req.content = "Here's my analysis..."
        req.senderID = "agent"
        req.senderName = "Agent"
        req.senderType = "agent"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.chatRequest(req)))

        let exp = expectation(description: "agent reply")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.messages.count, 1)
            XCTAssertEqual(vm.messages[0].role, .assistant)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - Ignore own messages

    func testIgnoreOwnMessages() {
        setFakeCredentials(deviceID: "my-node")
        let session = makeSession(ownerNodeId: "my-node")
        let vm = makeVM(session: session)

        var req = Teamclaw_ChatRequest()
        req.sessionID = "collab-1"
        req.content = "my own msg"
        req.senderID = "my-node"
        req.senderType = "human"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.chatRequest(req)))

        let exp = expectation(description: "ignored")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.messages.count, 0)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - Ignore other sessions

    func testIgnoresMessagesForOtherSessions() {
        setFakeCredentials()
        let session = makeSession(id: "collab-1")
        let vm = makeVM(session: session)

        var req = Teamclaw_ChatRequest()
        req.sessionID = "other-session"
        req.content = "not for us"
        req.senderID = "someone"
        req.senderType = "human"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.chatRequest(req)))

        let exp = expectation(description: "ignored")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.messages.count, 0)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - Leave session

    func testLeaveSessionPublishesAndUnsubscribes() {
        setFakeCredentials(deviceID: "my-node")
        let session = makeSession(ownerNodeId: "other-node")
        let vm = makeVM(session: session)

        vm.leaveSession()

        XCTAssertGreaterThanOrEqual(mockMQTT.publishCalls.count, 1)
        let lastPublish = mockMQTT.publishCalls.last!
        guard case .collabControl(let ctrl) = lastPublish.message.payload else {
            XCTFail("Expected collabControl"); return
        }
        XCTAssertEqual(ctrl.type, .collabLeave)
        XCTAssertEqual(ctrl.sessionID, "collab-1")

        XCTAssertEqual(mockMQTT.unsubscribeCalls.count, 1)
        XCTAssertTrue(mockMQTT.unsubscribeCalls[0].contains("session/collab-1"))
    }

    // MARK: - End session

    func testEndSessionPublishesCollabEnd() {
        setFakeCredentials(deviceID: "owner-node")
        let session = makeSession(ownerNodeId: "owner-node")
        let vm = makeVM(session: session)

        vm.endSession()

        let lastPublish = mockMQTT.publishCalls.last!
        guard case .collabControl(let ctrl) = lastPublish.message.payload else {
            XCTFail("Expected collabControl END"); return
        }
        XCTAssertEqual(ctrl.type, .collabEnd)
    }

    // MARK: - Receive CollabControl END

    func testReceiveCollabEndArchivesSession() {
        setFakeCredentials(deviceID: "my-node")
        let session = makeSession(ownerNodeId: "owner")
        let vm = makeVM(session: session)

        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabEnd
        ctrl.senderID = "owner"
        ctrl.senderName = "Owner"
        ctrl.sessionID = "collab-1"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl)))

        let exp = expectation(description: "end received")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.messages.count, 1)
            XCTAssertTrue(vm.messages[0].content.contains("结束"))
            XCTAssertTrue(session.isArchived)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - Receive CollabControl LEAVE

    func testReceiveCollabLeaveAddsSystemMessage() {
        setFakeCredentials(deviceID: "my-node")
        let session = makeSession(ownerNodeId: "owner")
        let vm = makeVM(session: session)

        var ctrl = Teamclaw_CollabControl()
        ctrl.type = .collabLeave
        ctrl.senderID = "other-user"
        ctrl.senderName = "小明"
        ctrl.sessionID = "collab-1"
        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.collabControl(ctrl)))

        let exp = expectation(description: "leave received")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.messages.count, 1)
            XCTAssertTrue(vm.messages[0].content.contains("小明"))
            XCTAssertFalse(session.isArchived)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - isOwner

    func testIsOwner() {
        setFakeCredentials(deviceID: "owner-node")
        let session = makeSession(ownerNodeId: "owner-node")
        let vm = makeVM(session: session)
        XCTAssertTrue(vm.isOwner)
    }

    func testIsNotOwner() {
        setFakeCredentials(deviceID: "other-node")
        let session = makeSession(ownerNodeId: "owner-node")
        let vm = makeVM(session: session)
        XCTAssertFalse(vm.isOwner)
    }
}

// MARK: - Credential helpers

private func setFakeCredentials(deviceID: String = "test-device") {
    let ud = UserDefaults.standard
    ud.set(true, forKey: "teamclaw_is_paired")
    ud.set("test-host", forKey: "teamclaw_mqtt_host")
    ud.set(8883, forKey: "teamclaw_mqtt_port")
    ud.set("test-user", forKey: "teamclaw_mqtt_username")
    ud.set("test-pass", forKey: "teamclaw_mqtt_password")
    ud.set("test-team", forKey: "teamclaw_team_id")
    ud.set(deviceID, forKey: "teamclaw_device_id")
    ud.set("test-desktop", forKey: "teamclaw_desktop_device_id")
    ud.set("Test Desktop", forKey: "teamclaw_paired_device_name")
}

private func clearFakeCredentials() {
    ["teamclaw_is_paired", "teamclaw_mqtt_host", "teamclaw_mqtt_port",
     "teamclaw_mqtt_username", "teamclaw_mqtt_password", "teamclaw_team_id",
     "teamclaw_device_id", "teamclaw_desktop_device_id", "teamclaw_paired_device_name"]
        .forEach { UserDefaults.standard.removeObject(forKey: $0) }
}
