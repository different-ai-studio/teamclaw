import Foundation

public struct IdeaRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public var workspaceID: String
    public let createdByActorID: String
    public var title: String
    public var description: String
    public var status: String
    public var archived: Bool
    public var sortOrder: Int
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        teamID: String,
        workspaceID: String,
        createdByActorID: String,
        title: String,
        description: String,
        status: String,
        archived: Bool,
        sortOrder: Int = 0,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.teamID = teamID
        self.workspaceID = workspaceID
        self.createdByActorID = createdByActorID
        self.title = title
        self.description = description
        self.status = status
        self.archived = archived
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var displayTitle: String {
        if !title.isEmpty {
            return title
        }

        if description.count <= 50 {
            return description
        }

        let prefix = description.prefix(50)
        if let lastSpace = prefix.lastIndex(of: " ") {
            return String(prefix[prefix.startIndex..<lastSpace]) + "…"
        }

        return String(prefix) + "…"
    }

    public var isOpen: Bool { status == "open" }
    public var isInProgress: Bool { status == "in_progress" }
    public var isDone: Bool { status == "done" }

    public var statusLabel: String {
        switch status {
        case "open":
            return "Open"
        case "in_progress":
            return "In Progress"
        case "done":
            return "Done"
        default:
            return status
        }
    }
}

public struct IdeaCreateInput: Equatable, Sendable {
    public let title: String
    public let description: String
    public let workspaceID: String

    public init(title: String, description: String, workspaceID: String) {
        self.title = title
        self.description = description
        self.workspaceID = workspaceID
    }
}

public struct IdeaUpdateInput: Equatable, Sendable {
    public let title: String
    public let description: String
    public let status: String
    public let workspaceID: String

    public init(title: String, description: String, status: String, workspaceID: String) {
        self.title = title
        self.description = description
        self.status = status
        self.workspaceID = workspaceID
    }
}

public struct IdeaActivityCreateInput: Equatable, Sendable {
    public let activityType: String
    public let content: String
    public let metadata: [String: String]
    public let attachmentURLs: [URL]

    public init(
        activityType: String,
        content: String,
        metadata: [String: String] = [:],
        attachmentURLs: [URL] = []
    ) {
        self.activityType = activityType
        self.content = content
        self.metadata = metadata
        self.attachmentURLs = attachmentURLs
    }
}
