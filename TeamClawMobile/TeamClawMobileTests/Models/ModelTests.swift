import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class ModelTests: XCTestCase {
    var container: ModelContainer!
    var context: ModelContext!

    override func setUp() {
        super.setUp()
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        container = try! ModelContainer(
            for: Session.self, ChatMessage.self, TeamMember.self, AutomationTask.self, Skill.self,
            configurations: config
        )
        context = container.mainContext
    }

    override func tearDown() {
        context = nil
        container = nil
        super.tearDown()
    }

    // MARK: - Session Tests

    func testSessionCreation() throws {
        let now = Date()
        let session = Session(
            id: "session-1",
            title: "Test Session",
            agentName: "Ally",
            agentAvatarURL: "https://example.com/avatar.png",
            lastMessageContent: "Hello!",
            lastMessageTime: now,
            isCollaborative: false,
            collaboratorIDs: []
        )
        context.insert(session)
        try context.save()

        let descriptor = FetchDescriptor<Session>()
        let sessions = try context.fetch(descriptor)
        XCTAssertEqual(sessions.count, 1)
        let fetched = sessions[0]
        XCTAssertEqual(fetched.id, "session-1")
        XCTAssertEqual(fetched.title, "Test Session")
        XCTAssertEqual(fetched.agentName, "Ally")
        XCTAssertEqual(fetched.agentAvatarURL, "https://example.com/avatar.png")
        XCTAssertEqual(fetched.lastMessageContent, "Hello!")
        XCTAssertEqual(fetched.isCollaborative, false)
        XCTAssertTrue(fetched.collaboratorIDs.isEmpty)
    }

    func testCollaborativeSession() throws {
        let session = Session(
            id: "session-collab",
            title: "Collaborative Session",
            agentName: "Ally",
            agentAvatarURL: nil,
            lastMessageContent: "Let's work together",
            lastMessageTime: Date(),
            isCollaborative: true,
            collaboratorIDs: ["user-1", "user-2", "user-3"]
        )
        context.insert(session)
        try context.save()

        let descriptor = FetchDescriptor<Session>()
        let sessions = try context.fetch(descriptor)
        XCTAssertEqual(sessions.count, 1)
        let fetched = sessions[0]
        XCTAssertTrue(fetched.isCollaborative)
        XCTAssertEqual(fetched.collaboratorIDs.count, 3)
        XCTAssertTrue(fetched.collaboratorIDs.contains("user-1"))
        XCTAssertTrue(fetched.collaboratorIDs.contains("user-2"))
        XCTAssertTrue(fetched.collaboratorIDs.contains("user-3"))
        XCTAssertNil(fetched.agentAvatarURL)
    }

    // MARK: - ChatMessage Tests

    func testChatMessageTypes() throws {
        let userMsg = ChatMessage(
            id: "msg-1",
            sessionID: "session-1",
            role: .user,
            content: "Hi there",
            timestamp: Date(),
            senderName: nil,
            isStreaming: false,
            imageURL: nil
        )
        let assistantMsg = ChatMessage(
            id: "msg-2",
            sessionID: "session-1",
            role: .assistant,
            content: "Hello! How can I help?",
            timestamp: Date(),
            senderName: "Ally",
            isStreaming: false,
            imageURL: nil
        )
        let collaboratorMsg = ChatMessage(
            id: "msg-3",
            sessionID: "session-1",
            role: .collaborator,
            content: "I can help too",
            timestamp: Date(),
            senderName: "Bob",
            isStreaming: false,
            imageURL: "https://example.com/img.png"
        )

        context.insert(userMsg)
        context.insert(assistantMsg)
        context.insert(collaboratorMsg)
        try context.save()

        let descriptor = FetchDescriptor<ChatMessage>(sortBy: [SortDescriptor(\.id)])
        let messages = try context.fetch(descriptor)
        XCTAssertEqual(messages.count, 3)

        let fetchedUser = messages.first(where: { $0.id == "msg-1" })!
        XCTAssertEqual(fetchedUser.role, .user)
        XCTAssertNil(fetchedUser.senderName)
        XCTAssertFalse(fetchedUser.isStreaming)
        XCTAssertNil(fetchedUser.imageURL)

        let fetchedAssistant = messages.first(where: { $0.id == "msg-2" })!
        XCTAssertEqual(fetchedAssistant.role, .assistant)
        XCTAssertEqual(fetchedAssistant.senderName, "Ally")

        let fetchedCollab = messages.first(where: { $0.id == "msg-3" })!
        XCTAssertEqual(fetchedCollab.role, .collaborator)
        XCTAssertEqual(fetchedCollab.senderName, "Bob")
        XCTAssertEqual(fetchedCollab.imageURL, "https://example.com/img.png")
    }

    func testChatMessageRoleRawValue() throws {
        let msg = ChatMessage(
            id: "msg-raw",
            sessionID: "session-1",
            role: .assistant,
            content: "Test",
            timestamp: Date(),
            senderName: nil,
            isStreaming: true,
            imageURL: nil
        )
        context.insert(msg)
        try context.save()

        let descriptor = FetchDescriptor<ChatMessage>()
        let messages = try context.fetch(descriptor)
        XCTAssertEqual(messages[0].roleRaw, "assistant")
        XCTAssertTrue(messages[0].isStreaming)
    }

    // MARK: - TeamMember Tests

    func testTeamMemberCreation() throws {
        let member = TeamMember(
            id: "member-1",
            name: "Alice",
            avatarURL: "https://example.com/alice.png",
            note: "Senior engineer"
        )
        context.insert(member)
        try context.save()

        let descriptor = FetchDescriptor<TeamMember>()
        let members = try context.fetch(descriptor)
        XCTAssertEqual(members.count, 1)
        XCTAssertEqual(members[0].id, "member-1")
        XCTAssertEqual(members[0].name, "Alice")
        XCTAssertEqual(members[0].avatarURL, "https://example.com/alice.png")
        XCTAssertEqual(members[0].note, "Senior engineer")
    }

    func testTeamMemberOptionalFields() throws {
        let member = TeamMember(
            id: "member-2",
            name: "Bob",
            avatarURL: nil,
            note: nil
        )
        context.insert(member)
        try context.save()

        let descriptor = FetchDescriptor<TeamMember>()
        let members = try context.fetch(descriptor)
        XCTAssertEqual(members[0].name, "Bob")
        XCTAssertNil(members[0].avatarURL)
        XCTAssertNil(members[0].note)
    }

    // MARK: - AutomationTask Tests

    func testAutomationTask() throws {
        let task = AutomationTask(
            id: "task-1",
            name: "Daily Report",
            status: .completed,
            lastRunTime: Date(),
            cronExpression: "0 9 * * *",
            taskDescription: "Generate daily summary report"
        )
        context.insert(task)
        try context.save()

        let descriptor = FetchDescriptor<AutomationTask>()
        let tasks = try context.fetch(descriptor)
        XCTAssertEqual(tasks.count, 1)
        let fetched = tasks[0]
        XCTAssertEqual(fetched.id, "task-1")
        XCTAssertEqual(fetched.name, "Daily Report")
        XCTAssertEqual(fetched.status, .completed)
        XCTAssertEqual(fetched.statusRaw, "completed")
        XCTAssertEqual(fetched.cronExpression, "0 9 * * *")
        XCTAssertEqual(fetched.taskDescription, "Generate daily summary report")
        XCTAssertNotNil(fetched.lastRunTime)
    }

    func testAutomationTaskAllStatuses() throws {
        let statuses: [TaskStatus] = [.running, .completed, .failed, .idle]
        for (index, status) in statuses.enumerated() {
            let task = AutomationTask(
                id: "task-status-\(index)",
                name: "Task \(index)",
                status: status,
                lastRunTime: nil,
                cronExpression: "* * * * *",
                taskDescription: "Test task"
            )
            context.insert(task)
        }
        try context.save()

        let descriptor = FetchDescriptor<AutomationTask>(sortBy: [SortDescriptor(\.id)])
        let tasks = try context.fetch(descriptor)
        XCTAssertEqual(tasks.count, 4)
        XCTAssertNil(tasks[0].lastRunTime)
    }

    // MARK: - Skill Tests

    func testSkill() throws {
        let skill = Skill(
            id: "skill-1",
            name: "Code Review",
            skillDescription: "Reviews code and provides feedback",
            isPersonal: true,
            isEnabled: true
        )
        context.insert(skill)
        try context.save()

        let descriptor = FetchDescriptor<Skill>()
        let skills = try context.fetch(descriptor)
        XCTAssertEqual(skills.count, 1)
        let fetched = skills[0]
        XCTAssertEqual(fetched.id, "skill-1")
        XCTAssertEqual(fetched.name, "Code Review")
        XCTAssertEqual(fetched.skillDescription, "Reviews code and provides feedback")
        XCTAssertTrue(fetched.isPersonal)
        XCTAssertTrue(fetched.isEnabled)
    }

    func testSkillPersonalFlag() throws {
        let personal = Skill(
            id: "skill-personal",
            name: "My Custom Skill",
            skillDescription: "Personal automation",
            isPersonal: true,
            isEnabled: false
        )
        let shared = Skill(
            id: "skill-shared",
            name: "Shared Tool",
            skillDescription: "Shared team skill",
            isPersonal: false,
            isEnabled: true
        )
        context.insert(personal)
        context.insert(shared)
        try context.save()

        let descriptor = FetchDescriptor<Skill>(sortBy: [SortDescriptor(\.id)])
        let skills = try context.fetch(descriptor)
        XCTAssertEqual(skills.count, 2)

        let fetchedPersonal = skills.first(where: { $0.id == "skill-personal" })!
        XCTAssertTrue(fetchedPersonal.isPersonal)
        XCTAssertFalse(fetchedPersonal.isEnabled)

        let fetchedShared = skills.first(where: { $0.id == "skill-shared" })!
        XCTAssertFalse(fetchedShared.isPersonal)
        XCTAssertTrue(fetchedShared.isEnabled)
    }
}
