import Combine
import Foundation
import SwiftData

@MainActor
final class TaskViewModel: ObservableObject {

    @Published var tasks: [AutomationTask] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    func loadTasks() {
        loadTasksFromDB()
        requestAutomations(page: 1)
    }

    func requestAutomations(page: Int = 1) {
        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_AutomationSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = Int32(page)
        pg.pageSize = 50
        req.pagination = pg
        let msg = ProtoMQTTCoder.makeEnvelope(.automationSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
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

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] message in
                switch message.payload {
                case .taskUpdate(let payload):
                    self?.handleTaskUpdate(payload)
                case .automationSyncResponse(let payload):
                    self?.handleAutomationSync(payload)
                default:
                    break
                }
            }
            .store(in: &cancellables)
    }

    private func handleTaskUpdate(_ payload: Teamclaw_TaskUpdate) {
        let descriptor = FetchDescriptor<AutomationTask>()
        guard let allTasks = try? modelContext.fetch(descriptor) else { return }
        guard let task = allTasks.first(where: { $0.id == payload.taskID }) else { return }

        if let newStatus = TaskStatus(rawValue: payload.status) {
            task.status = newStatus
        }
        if payload.hasLastRunTime {
            task.lastRunTime = Date(timeIntervalSince1970: payload.lastRunTime)
        }
        try? modelContext.save()
        loadTasksFromDB()
    }

    private func handleAutomationSync(_ response: Teamclaw_AutomationSyncResponse) {
        let pg = response.pagination
        let isFirstPage = pg.page <= 1

        if isFirstPage {
            let descriptor = FetchDescriptor<AutomationTask>()
            if let existing = try? modelContext.fetch(descriptor) {
                for task in existing { modelContext.delete(task) }
            }
        }

        for data in response.tasks {
            let task = AutomationTask(
                id: data.id,
                name: data.name,
                status: TaskStatus(rawValue: data.hasStatus ? data.status : "") ?? .idle,
                lastRunTime: data.hasLastRunTime ? Date(timeIntervalSince1970: data.lastRunTime) : nil,
                cronExpression: data.cronExpression,
                taskDescription: data.description_p
            )
            modelContext.insert(task)
        }

        try? modelContext.save()

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestAutomations(page: Int(pg.page) + 1)
        } else {
            loadTasksFromDB()
        }
    }

    private func loadTasksFromDB() {
        let descriptor = FetchDescriptor<AutomationTask>(sortBy: [SortDescriptor(\.name)])
        tasks = (try? modelContext.fetch(descriptor)) ?? []
    }

    private func publishTaskUpdate(taskID: String, status: TaskStatus) {
        var update = Teamclaw_TaskUpdate()
        update.taskID = taskID
        update.status = status.rawValue
        let msg = ProtoMQTTCoder.makeEnvelope(.taskUpdate(update))
        mqttService.publish(topic: "task/update", message: msg, qos: 1)
    }
}
