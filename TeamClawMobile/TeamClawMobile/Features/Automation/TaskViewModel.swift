import Combine
import Foundation
import SwiftData

@MainActor
final class TaskViewModel: ObservableObject {

    @Published var tasks: [AutomationTask] = []
    @Published private(set) var isDesktopOnline: Bool = false

    private var modelContext: ModelContext?
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    /// IDs received across all pages of the current sync cycle.
    private var receivedIDs: Set<String> = []

    func setModelContext(_ context: ModelContext) {
        guard modelContext == nil else { return }
        modelContext = context
        loadTasksFromDB()
    }

    init(mqttService: MQTTServiceProtocol) {
        self.mqttService = mqttService
        subscribeToMQTT()
        subscribeToStatus()
    }

    func loadTasks() {
        guard isDesktopOnline else { return }
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
        modelContext?.insert(task)
        try? modelContext?.save()
        loadTasksFromDB()
        publishTaskUpdate(taskID: task.id, status: .idle)
    }

    func deleteTask(_ task: AutomationTask) {
        modelContext?.delete(task)
        try? modelContext?.save()
        loadTasksFromDB()
    }

    func updateTask(_ task: AutomationTask, name: String, cron: String, description: String) {
        task.name = name
        task.cronExpression = cron
        task.taskDescription = description
        try? modelContext?.save()
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
        guard let modelContext else { return }
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
        guard let modelContext else { return }
        let pg = response.pagination

        // Don't wipe cache when server returns empty
        guard !response.tasks.isEmpty || pg.total > 0 else { return }

        let isFirstPage = pg.page <= 1
        if isFirstPage { receivedIDs.removeAll() }

        // Upsert: @Attribute(.unique) on id makes insert act as upsert
        for data in response.tasks {
            receivedIDs.insert(data.id)
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

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestAutomations(page: Int(pg.page) + 1)
        } else {
            // Remove stale tasks not present in this sync cycle
            let descriptor = FetchDescriptor<AutomationTask>()
            if let existing = try? modelContext.fetch(descriptor) {
                for task in existing where !receivedIDs.contains(task.id) {
                    modelContext.delete(task)
                }
            }
            try? modelContext.save()
            loadTasksFromDB()
        }
    }

    private func subscribeToStatus() {
        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_StatusReport? in
                if case .statusReport(let status) = msg.payload { return status }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.isDesktopOnline = status.online
            }
            .store(in: &cancellables)
    }

    private func loadTasksFromDB() {
        guard let modelContext else { return }
        let descriptor = FetchDescriptor<AutomationTask>(sortBy: [SortDescriptor(\.name)])
        tasks = (try? modelContext.fetch(descriptor)) ?? []
    }

    private func publishTaskUpdate(taskID: String, status: TaskStatus) {
        guard let creds = PairingManager.currentCredentials else { return }
        var update = Teamclaw_TaskUpdate()
        update.taskID = taskID
        update.status = status.rawValue
        let msg = ProtoMQTTCoder.makeEnvelope(.taskUpdate(update))
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }
}
