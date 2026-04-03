import Combine
import Foundation
import SwiftData

@MainActor
final class TaskViewModel: ObservableObject {

    // MARK: - Published Properties

    @Published var tasks: [AutomationTask] = []

    // MARK: - Private

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Init

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    // MARK: - Public Methods

    func loadTasks() {
        loadTasksFromDB()
        requestAutomations()
    }

    func requestAutomations() {
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        mqttService.publishRaw(topic: topic, payload: "/automations", qos: 1)
    }

    func addTask(name: String, cron: String, description: String) {
        let task = AutomationTask(
            id: UUID().uuidString,
            name: name,
            status: .idle,
            cronExpression: cron,
            taskDescription: description
        )
        modelContext.insert(task)
        try? modelContext.save()
        loadTasksFromDB()
        publishTaskUpdate(taskID: task.id, status: .idle)
    }

    func deleteTask(_ task: AutomationTask) {
        modelContext.delete(task)
        try? modelContext.save()
        loadTasksFromDB()
    }

    func updateTask(_ task: AutomationTask, name: String, cron: String, description: String) {
        task.name = name
        task.cronExpression = cron
        task.taskDescription = description
        try? modelContext.save()
        loadTasksFromDB()
    }

    // MARK: - Private Methods

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] message in
                switch message.payload {
                case .taskUpdate(let payload):
                    self?.handleTaskUpdate(payload)
                case .automationSync(let payload):
                    self?.handleAutomationSync(payload)
                default:
                    break
                }
            }
            .store(in: &cancellables)
    }

    private func handleTaskUpdate(_ payload: TaskUpdatePayload) {
        let descriptor = FetchDescriptor<AutomationTask>()
        guard let allTasks = try? modelContext.fetch(descriptor) else { return }
        guard let task = allTasks.first(where: { $0.id == payload.taskID }) else { return }

        if let newStatus = TaskStatus(rawValue: payload.status) {
            task.status = newStatus
        }
        if let lastRunTime = payload.lastRunTime {
            task.lastRunTime = Date(timeIntervalSince1970: lastRunTime)
        }
        try? modelContext.save()
        loadTasksFromDB()
    }

    private func handleAutomationSync(_ payload: AutomationSyncPayload) {
        let descriptor = FetchDescriptor<AutomationTask>()
        if let existing = try? modelContext.fetch(descriptor) {
            for task in existing {
                modelContext.delete(task)
            }
        }

        for data in payload.tasks {
            let task = AutomationTask(
                id: data.id,
                name: data.name,
                status: TaskStatus(rawValue: data.status ?? "") ?? .idle,
                lastRunTime: data.lastRunTime.map { Date(timeIntervalSince1970: $0) },
                cronExpression: data.cronExpression,
                taskDescription: data.description
            )
            modelContext.insert(task)
        }

        try? modelContext.save()
        loadTasksFromDB()
    }

    private func loadTasksFromDB() {
        let descriptor = FetchDescriptor<AutomationTask>(
            sortBy: [SortDescriptor(\.name)]
        )
        tasks = (try? modelContext.fetch(descriptor)) ?? []
    }

    private func publishTaskUpdate(taskID: String, status: TaskStatus) {
        let payload = TaskUpdatePayload(
            taskID: taskID,
            status: status.rawValue,
            lastRunTime: nil
        )
        let message = MQTTMessage(
            id: UUID().uuidString,
            type: .taskUpdate,
            timestamp: Date().timeIntervalSince1970,
            payload: .taskUpdate(payload)
        )
        mqttService.publish(topic: "task/update", message: message, qos: 1)
    }
}
