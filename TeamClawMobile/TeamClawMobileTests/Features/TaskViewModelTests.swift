import XCTest
import SwiftData
@testable import TeamClawMobile

@MainActor
final class TaskViewModelTests: XCTestCase {

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

    // MARK: - Test 1: Add Task

    func testAddTask() throws {
        let viewModel = TaskViewModel(modelContext: context, mqttService: mockMQTT)

        viewModel.addTask(name: "每日报告", cron: "0 9 * * *", description: "生成每日运营报告")

        XCTAssertEqual(viewModel.tasks.count, 1)
        XCTAssertEqual(viewModel.tasks[0].name, "每日报告")
        XCTAssertEqual(viewModel.tasks[0].status, .idle)
    }

    // MARK: - Test 2: Delete Task

    func testDeleteTask() throws {
        let viewModel = TaskViewModel(modelContext: context, mqttService: mockMQTT)

        viewModel.addTask(name: "临时任务", cron: "*/5 * * * *", description: "测试用")
        XCTAssertEqual(viewModel.tasks.count, 1)

        viewModel.deleteTask(viewModel.tasks[0])
        XCTAssertEqual(viewModel.tasks.count, 0)
    }

    // MARK: - Test 3: Update Task

    func testUpdateTask() throws {
        let viewModel = TaskViewModel(modelContext: context, mqttService: mockMQTT)

        viewModel.addTask(name: "原始名称", cron: "0 0 * * *", description: "原始描述")
        XCTAssertEqual(viewModel.tasks.count, 1)

        let task = viewModel.tasks[0]
        viewModel.updateTask(task, name: "更新名称", cron: "0 12 * * *", description: "更新描述")

        XCTAssertEqual(viewModel.tasks.count, 1)
        XCTAssertEqual(viewModel.tasks[0].name, "更新名称")
        XCTAssertEqual(viewModel.tasks[0].cronExpression, "0 12 * * *")
        XCTAssertEqual(viewModel.tasks[0].taskDescription, "更新描述")
    }
}
