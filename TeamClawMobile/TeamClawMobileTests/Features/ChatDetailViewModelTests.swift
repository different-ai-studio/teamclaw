import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class ChatDetailViewModelTests: XCTestCase {

    var container: ModelContainer!
    var context: ModelContext!
    var mockMQTT: MockMQTTService!

    override func setUp() {
        super.setUp()
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self, Talent.self,
            configurations: config
        )
        context = container.mainContext
        mockMQTT = MockMQTTService()
    }

    override func tearDown() {
        context = nil
        container = nil
        mockMQTT = nil
        super.tearDown()
    }

    private func makeVM(sessionID: String = "test-session") -> ChatDetailViewModel {
        let vm = ChatDetailViewModel(sessionID: sessionID, mqttService: mockMQTT)
        vm.setModelContext(context)
        return vm
    }

    // MARK: - Send

    func testSendMessageCreatesUserMessage() throws {
        let vm = makeVM()
        vm.inputText = "Hello, assistant!"
        vm.sendMessage()

        XCTAssertEqual(vm.messages.count, 1)
        XCTAssertEqual(vm.messages[0].role, .user)
        XCTAssertEqual(vm.messages[0].content, "Hello, assistant!")
        XCTAssertEqual(vm.inputText, "")
    }

    func testCannotSendWhenDesktopOffline() throws {
        let vm = makeVM()
        vm.isDesktopOnline = false
        vm.inputText = "This should not send"
        vm.sendMessage()

        XCTAssertEqual(vm.messages.count, 0)
    }

    func testCannotSendEmptyMessage() throws {
        let vm = makeVM()
        vm.inputText = "   "
        vm.sendMessage()

        XCTAssertEqual(vm.messages.count, 0)
    }

    func testSendPublishesProtobuf() throws {
        // Set up fake credentials so publish works
        setFakePairingCredentials()
        defer { clearFakePairingCredentials() }

        let vm = makeVM()
        vm.inputText = "Hello"
        vm.sendMessage()

        XCTAssertEqual(mockMQTT.publishCalls.count, 1)
        let published = mockMQTT.publishCalls[0]
        guard case .chatRequest(let req) = published.message.payload else {
            XCTFail("Expected chatRequest payload")
            return
        }
        XCTAssertEqual(req.sessionID, "test-session")
        XCTAssertEqual(req.content, "Hello")
    }

    // MARK: - Streaming

    func testStreamingDeltaUpdatesContent() throws {
        let vm = makeVM()
        let exp = expectation(description: "Streaming content updates")

        var delta1 = Teamclaw_ChatResponse()
        delta1.sessionID = "test-session"
        delta1.seq = 0
        delta1.event = .delta("Hello ")

        var delta2 = Teamclaw_ChatResponse()
        delta2.sessionID = "test-session"
        delta2.seq = 1
        delta2.event = .delta("World")

        vm.handleStreamChunk(response: delta1)
        XCTAssertTrue(vm.isStreaming)

        vm.handleStreamChunk(response: delta2)

        // Give aggregator time to emit
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            XCTAssertTrue(vm.streamingContent.contains("Hello"))
            exp.fulfill()
        }

        wait(for: [exp], timeout: 1.0)
    }

    func testStreamDoneCreatesAssistantMessage() throws {
        let vm = makeVM()

        var delta = Teamclaw_ChatResponse()
        delta.sessionID = "test-session"
        delta.seq = 0
        delta.event = .delta("Answer")

        var done = Teamclaw_ChatResponse()
        done.sessionID = "test-session"
        done.seq = 1
        done.event = .done(Teamclaw_StreamDone())

        vm.handleStreamChunk(response: delta)

        // Wait for aggregator to emit
        let exp = expectation(description: "Done processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            vm.handleStreamChunk(response: done)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                XCTAssertFalse(vm.isStreaming)
                XCTAssertEqual(vm.messages.count, 1)
                XCTAssertEqual(vm.messages[0].role, .assistant)
                exp.fulfill()
            }
        }

        wait(for: [exp], timeout: 2.0)
    }

    func testStreamErrorCreatesMessageWithError() throws {
        let vm = makeVM()

        var delta = Teamclaw_ChatResponse()
        delta.sessionID = "test-session"
        delta.seq = 0
        delta.event = .delta("Partial")

        var err = Teamclaw_StreamError()
        err.message = "rate limited"
        var errorResp = Teamclaw_ChatResponse()
        errorResp.sessionID = "test-session"
        errorResp.seq = 1
        errorResp.event = .error(err)

        vm.handleStreamChunk(response: delta)

        let exp = expectation(description: "Error processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            vm.handleStreamChunk(response: errorResp)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                XCTAssertFalse(vm.isStreaming)
                XCTAssertEqual(vm.messages.count, 1)
                XCTAssertTrue(vm.messages[0].content.contains("Error"))
                exp.fulfill()
            }
        }

        wait(for: [exp], timeout: 2.0)
    }

    // MARK: - Message History Sync

    func testMessageSyncMergesWithoutDuplicates() throws {
        let vm = makeVM()

        // Pre-insert a message
        let existing = ChatMessage(id: "msg-1", sessionID: "test-session", role: .user, content: "Hi", timestamp: Date())
        context.insert(existing)
        try context.save()
        vm.loadMessages()
        XCTAssertEqual(vm.messages.count, 1)

        // Simulate MessageSyncResponse with one existing + one new
        var resp = Teamclaw_MessageSyncResponse()
        resp.sessionID = "test-session"

        var msg1 = Teamclaw_ChatMessageData()
        msg1.id = "msg-1"
        msg1.role = "user"
        msg1.content = "Hi"
        msg1.timestamp = Date().timeIntervalSince1970

        var msg2 = Teamclaw_ChatMessageData()
        msg2.id = "msg-2"
        msg2.role = "assistant"
        msg2.content = "Hello!"
        msg2.timestamp = Date().timeIntervalSince1970

        resp.messages = [msg1, msg2]

        let syncMsg = ProtoMQTTCoder.makeEnvelope(.messageSyncResponse(resp))
        mockMQTT.simulateMessage(syncMsg)

        let exp = expectation(description: "Sync processed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            XCTAssertEqual(vm.messages.count, 2) // No duplicate
            exp.fulfill()
        }

        wait(for: [exp], timeout: 1.0)
    }

    func testRequestHistoryOnEmptyLoad() throws {
        setFakePairingCredentials()
        defer { clearFakePairingCredentials() }

        let vm = makeVM()
        vm.loadMessages()

        let syncCalls = mockMQTT.publishCalls.filter {
            if case .messageSyncRequest = $0.message.payload { return true }
            return false
        }
        XCTAssertEqual(syncCalls.count, 1)
    }

    func testLoadingHistoryState() throws {
        setFakePairingCredentials()
        defer { clearFakePairingCredentials() }

        let vm = makeVM()
        XCTAssertFalse(vm.isLoadingHistory)

        vm.requestMessageHistory()
        XCTAssertTrue(vm.isLoadingHistory)
    }
}

// MARK: - Test Helpers

private func setFakePairingCredentials() {
    let ud = UserDefaults.standard
    ud.set(true, forKey: "teamclaw_is_paired")
    ud.set("test-host", forKey: "teamclaw_mqtt_host")
    ud.set(8883, forKey: "teamclaw_mqtt_port")
    ud.set("test-user", forKey: "teamclaw_mqtt_username")
    ud.set("test-pass", forKey: "teamclaw_mqtt_password")
    ud.set("test-team", forKey: "teamclaw_team_id")
    ud.set("test-device", forKey: "teamclaw_device_id")
    ud.set("test-desktop", forKey: "teamclaw_desktop_device_id")
    ud.set("Test Desktop", forKey: "teamclaw_paired_device_name")
}

private func clearFakePairingCredentials() {
    let keys = ["teamclaw_is_paired", "teamclaw_mqtt_host", "teamclaw_mqtt_port",
                "teamclaw_mqtt_username", "teamclaw_mqtt_password", "teamclaw_team_id",
                "teamclaw_device_id", "teamclaw_desktop_device_id", "teamclaw_paired_device_name"]
    keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
}
