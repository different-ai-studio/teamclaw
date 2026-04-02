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
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self,
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

    // MARK: - Test 1: sendMessage creates a user message

    func testSendMessageCreatesUserMessage() throws {
        let viewModel = ChatDetailViewModel(
            sessionID: "test-session",
            modelContext: context,
            mqttService: mockMQTT
        )
        viewModel.inputText = "Hello, assistant!"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].content, "Hello, assistant!")
        XCTAssertEqual(viewModel.inputText, "")
    }

    // MARK: - Test 2: Cannot send when desktop is offline

    func testCannotSendWhenDesktopOffline() throws {
        let viewModel = ChatDetailViewModel(
            sessionID: "test-session",
            modelContext: context,
            mqttService: mockMQTT
        )
        viewModel.isDesktopOnline = false
        viewModel.inputText = "This should not send"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 0)
    }
}
