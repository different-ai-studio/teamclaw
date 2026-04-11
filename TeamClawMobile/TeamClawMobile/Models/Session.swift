import Foundation
import SwiftData

@Model
final class Session {
    @Attribute(.unique) var id: String
    var title: String
    var agentName: String
    var agentAvatarURL: String?
    var lastMessageContent: String
    var lastMessageTime: Date
    var isCollaborative: Bool
    var collaboratorIDs: [String]
    // Session status (e.g. "running", "completed", "error")
    var status: String?
    // Code-change summary from the desktop
    var summaryAdditions: Int
    var summaryDeletions: Int
    var summaryFiles: Int
    var isPinned: Bool
    var isArchived: Bool

    init(
        id: String,
        title: String,
        agentName: String,
        agentAvatarURL: String? = nil,
        lastMessageContent: String,
        lastMessageTime: Date,
        isCollaborative: Bool = false,
        collaboratorIDs: [String] = [],
        status: String? = nil,
        summaryAdditions: Int = 0,
        summaryDeletions: Int = 0,
        summaryFiles: Int = 0,
        isPinned: Bool = false,
        isArchived: Bool = false
    ) {
        self.id = id
        self.title = title
        self.agentName = agentName
        self.agentAvatarURL = agentAvatarURL
        self.lastMessageContent = lastMessageContent
        self.lastMessageTime = lastMessageTime
        self.isCollaborative = isCollaborative
        self.collaboratorIDs = collaboratorIDs
        self.status = status
        self.summaryAdditions = summaryAdditions
        self.summaryDeletions = summaryDeletions
        self.summaryFiles = summaryFiles
        self.isPinned = isPinned
        self.isArchived = isArchived
    }
}
