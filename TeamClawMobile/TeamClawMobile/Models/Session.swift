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

    init(
        id: String,
        title: String,
        agentName: String,
        agentAvatarURL: String? = nil,
        lastMessageContent: String,
        lastMessageTime: Date,
        isCollaborative: Bool = false,
        collaboratorIDs: [String] = []
    ) {
        self.id = id
        self.title = title
        self.agentName = agentName
        self.agentAvatarURL = agentAvatarURL
        self.lastMessageContent = lastMessageContent
        self.lastMessageTime = lastMessageTime
        self.isCollaborative = isCollaborative
        self.collaboratorIDs = collaboratorIDs
    }
}
