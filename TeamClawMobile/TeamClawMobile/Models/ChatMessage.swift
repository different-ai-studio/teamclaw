import Foundation
import SwiftData

enum MessageRole: String, Codable {
    case user
    case assistant
    case collaborator
}

@Model
final class ChatMessage {
    @Attribute(.unique) var id: String
    var sessionID: String
    var roleRaw: String
    var content: String
    var timestamp: Date
    var senderName: String?
    var isStreaming: Bool
    var imageURL: String?

    var role: MessageRole {
        get { MessageRole(rawValue: roleRaw) ?? .user }
        set { roleRaw = newValue.rawValue }
    }

    init(
        id: String,
        sessionID: String,
        role: MessageRole,
        content: String,
        timestamp: Date,
        senderName: String? = nil,
        isStreaming: Bool = false,
        imageURL: String? = nil
    ) {
        self.id = id
        self.sessionID = sessionID
        self.roleRaw = role.rawValue
        self.content = content
        self.timestamp = timestamp
        self.senderName = senderName
        self.isStreaming = isStreaming
        self.imageURL = imageURL
    }
}
