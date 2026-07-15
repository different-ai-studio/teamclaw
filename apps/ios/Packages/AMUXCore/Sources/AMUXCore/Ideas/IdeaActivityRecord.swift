import Foundation

public struct IdeaActivityRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public let ideaID: String
    public let actorID: String
    public let activityType: String
    public let content: String
    public let metadata: [String: String]
    public let attachmentURLs: [URL]
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: String,
        teamID: String,
        ideaID: String,
        actorID: String,
        activityType: String,
        content: String,
        metadata: [String: String] = [:],
        attachmentURLs: [URL] = [],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.teamID = teamID
        self.ideaID = ideaID
        self.actorID = actorID
        self.activityType = activityType
        self.content = content
        self.metadata = metadata
        self.attachmentURLs = attachmentURLs
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var isProgress: Bool { activityType == "progress" }
    public var isStatusChange: Bool { activityType == "status_change" }
    public var isReorder: Bool { activityType == "reorder" }
}
