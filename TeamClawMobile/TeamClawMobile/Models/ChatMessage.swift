import Foundation
import SwiftData

enum MessageRole: String, Codable {
    case user
    case assistant
    case collaborator
}

struct ToolCallInfo: Codable, Identifiable {
    var id: String { toolCallId }
    let toolCallId: String
    let toolName: String
    var status: String
    let argumentsJson: String
    let resultSummary: String
    let durationMs: Int

    var summary: String? {
        guard let data = argumentsJson.data(using: .utf8),
              let args = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let path = args["path"] as? String { return path }
        if let command = args["command"] as? String {
            return command.count > 60 ? String(command.prefix(60)) + "..." : command
        }
        if let query = args["query"] as? String { return query }
        if let url = args["url"] as? String { return url }
        if let pattern = args["pattern"] as? String { return pattern }
        return nil
    }
}

struct MessagePart: Codable {
    let type: String
    let text: String?
    let tool: ToolCallInfo?
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
    var partsJSON: String
    var hasThinking: Bool

    var role: MessageRole {
        get { MessageRole(rawValue: roleRaw) ?? .user }
        set { roleRaw = newValue.rawValue }
    }

    var parts: [MessagePart] {
        guard let data = partsJSON.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([MessagePart].self, from: data)) ?? []
    }

    init(
        id: String,
        sessionID: String,
        role: MessageRole,
        content: String,
        timestamp: Date,
        senderName: String? = nil,
        isStreaming: Bool = false,
        imageURL: String? = nil,
        partsJSON: String = "[]",
        hasThinking: Bool = false
    ) {
        self.id = id
        self.sessionID = sessionID
        self.roleRaw = role.rawValue
        self.content = content
        self.timestamp = timestamp
        self.senderName = senderName
        self.isStreaming = isStreaming
        self.imageURL = imageURL
        self.partsJSON = partsJSON
        self.hasThinking = hasThinking
    }
}
