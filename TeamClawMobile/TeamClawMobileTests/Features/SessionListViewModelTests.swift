import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class SessionListViewModelTests: XCTestCase {

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

    // MARK: - Test 1: Sessions sorted by lastMessageTime descending

    func testSessionsSortedByLastMessageTime() throws {
        let now = Date()
        let older = now.addingTimeInterval(-3600) // 1 hour ago

        let olderSession = Session(
            id: "session-old",
            title: "Older Session",
            agentName: "运营搭档",
            lastMessageContent: "Old message",
            lastMessageTime: older
        )
        let newerSession = Session(
            id: "session-new",
            title: "Newer Session",
            agentName: "代码搭档",
            lastMessageContent: "New message",
            lastMessageTime: now
        )

        context.insert(olderSession)
        context.insert(newerSession)
        try context.save()

        let viewModel = SessionListViewModel(modelContext: context, mqttService: mockMQTT)
        viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 2)
        XCTAssertEqual(viewModel.sessions[0].id, "session-new", "Newest session should be first")
        XCTAssertEqual(viewModel.sessions[1].id, "session-old", "Oldest session should be last")
    }

    // MARK: - Test 2: Search filters sessions

    func testSearchFiltersSessions() throws {
        let now = Date()

        let session1 = Session(
            id: "session-1",
            title: "运营搭档",
            agentName: "运营助手",
            lastMessageContent: "帮你整理了日报",
            lastMessageTime: now
        )
        let session2 = Session(
            id: "session-2",
            title: "代码搭档",
            agentName: "代码助手",
            lastMessageContent: "方案可以优化",
            lastMessageTime: now.addingTimeInterval(-60)
        )

        context.insert(session1)
        context.insert(session2)
        try context.save()

        let viewModel = SessionListViewModel(modelContext: context, mqttService: mockMQTT)
        viewModel.loadSessions()

        XCTAssertEqual(viewModel.sessions.count, 2)

        viewModel.searchText = "运营"
        viewModel.applySearch()

        XCTAssertEqual(viewModel.filteredSessions.count, 1)
        XCTAssertEqual(viewModel.filteredSessions[0].id, "session-1")
    }
}
