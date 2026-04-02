import Foundation
import SwiftData

enum TaskStatus: String, Codable {
    case running
    case completed
    case failed
    case idle
}

@Model
final class AutomationTask {
    @Attribute(.unique) var id: String
    var name: String
    var statusRaw: String
    var lastRunTime: Date?
    var cronExpression: String
    var taskDescription: String

    var status: TaskStatus {
        get { TaskStatus(rawValue: statusRaw) ?? .idle }
        set { statusRaw = newValue.rawValue }
    }

    init(
        id: String,
        name: String,
        status: TaskStatus,
        lastRunTime: Date? = nil,
        cronExpression: String,
        taskDescription: String
    ) {
        self.id = id
        self.name = name
        self.statusRaw = status.rawValue
        self.lastRunTime = lastRunTime
        self.cronExpression = cronExpression
        self.taskDescription = taskDescription
    }
}
