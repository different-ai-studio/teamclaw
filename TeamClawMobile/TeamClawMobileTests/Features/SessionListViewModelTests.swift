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
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self, Talent.self,
            configurations: config
        )
        context = container.mainContext
        mockMQTT = MockMQTTService()
    }

    override func tearDown() {
        context = nil; container = nil; mockMQTT = nil
        super.tearDown()
    }

    private func makeVM() -> SessionListViewModel {
        SessionListViewModel(modelContext: context, mqttService: mockMQTT)
    }

    // MARK: - Sorting & Search

    func testSessionsSortedByLastMessageTime() throws {
        let now = Date()
        context.insert(Session(id: "old", title: "Older", agentName: "AI", lastMessageContent: "", lastMessageTime: now.addingTimeInterval(-3600)))
        context.insert(Session(id: "new", title: "Newer", agentName: "AI", lastMessageContent: "", lastMessageTime: now))
        try context.save()

        let vm = makeVM()
        vm.loadSessions()

        XCTAssertEqual(vm.sessions.count, 2)
        XCTAssertEqual(vm.sessions[0].id, "new")
        XCTAssertEqual(vm.sessions[1].id, "old")
    }

    func testSearchFiltersSessions() throws {
        let now = Date()
        context.insert(Session(id: "s1", title: "运营搭档", agentName: "AI", lastMessageContent: "", lastMessageTime: now))
        context.insert(Session(id: "s2", title: "代码搭档", agentName: "AI", lastMessageContent: "", lastMessageTime: now))
        try context.save()

        let vm = makeVM()
        vm.loadSessions()
        vm.searchText = "运营"
        vm.applySearch()

        XCTAssertEqual(vm.filteredSessions.count, 1)
        XCTAssertEqual(vm.filteredSessions[0].id, "s1")
    }

    // MARK: - Sync

    func testSessionSyncCreatesNewSessions() {
        let vm = makeVM()

        var session = Teamclaw_SessionData()
        session.id = "synced-1"
        session.title = "From Desktop"
        session.updated = Int64(Date().timeIntervalSince1970)

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 1

        var resp = Teamclaw_SessionSyncResponse()
        resp.sessions = [session]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.sessionSyncResponse(resp)))

        let exp = expectation(description: "Session synced")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.sessions.count, 1)
            XCTAssertEqual(vm.sessions[0].title, "From Desktop")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    func testSessionSyncUpdatesExistingTitle() throws {
        context.insert(Session(id: "s1", title: "Old Title", agentName: "AI", lastMessageContent: "", lastMessageTime: Date()))
        try context.save()

        let vm = makeVM()
        vm.loadSessions()
        XCTAssertEqual(vm.sessions[0].title, "Old Title")

        var session = Teamclaw_SessionData()
        session.id = "s1"
        session.title = "New Title"
        session.updated = Int64(Date().timeIntervalSince1970)

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 1

        var resp = Teamclaw_SessionSyncResponse()
        resp.sessions = [session]
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.sessionSyncResponse(resp)))

        let exp = expectation(description: "Title updated")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertEqual(vm.sessions[0].title, "New Title")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - Loading State

    func testLoadingClearsOnSyncResponse() {
        let vm = makeVM()
        // Manually set loading (requestSessions needs credentials)
        vm.isLoading = true

        var pg = Teamclaw_PageInfo()
        pg.page = 1; pg.pageSize = 50; pg.total = 0

        var resp = Teamclaw_SessionSyncResponse()
        resp.sessions = []
        resp.pagination = pg

        mockMQTT.simulateMessage(ProtoMQTTCoder.makeEnvelope(.sessionSyncResponse(resp)))

        let exp = expectation(description: "Loading cleared")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            XCTAssertFalse(vm.isLoading)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    // MARK: - CRUD

    func testCreateSession() {
        let vm = makeVM()
        let session = vm.createSession()

        XCTAssertEqual(vm.sessions.count, 1)
        XCTAssertEqual(session.title, "新会话")
    }

    func testDeleteSession() throws {
        context.insert(Session(id: "s1", title: "Test", agentName: "AI", lastMessageContent: "", lastMessageTime: Date()))
        try context.save()

        let vm = makeVM()
        vm.loadSessions()
        XCTAssertEqual(vm.sessions.count, 1)

        vm.deleteSession(vm.sessions[0])
        XCTAssertTrue(vm.sessions.isEmpty)
    }
}
