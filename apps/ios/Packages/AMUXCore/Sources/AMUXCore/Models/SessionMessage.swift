import Foundation
import SwiftData

@Model
public final class SessionMessage {
    @Attribute(.unique) public var messageId: String
    public var sessionId: String
    public var senderActorId: String
    public var kind: String             // "text", "system", "work_event"
    public var content: String
    public var createdAt: Date
    public var replyToMessageId: String
    public var mentions: String         // comma-separated actor IDs
    public var model: String?

    public init(
        messageId: String,
        sessionId: String = "",
        senderActorId: String = "",
        kind: String = "text",
        content: String = "",
        createdAt: Date = .now,
        replyToMessageId: String = "",
        mentions: String = ""
    ) {
        self.messageId = messageId
        self.sessionId = sessionId
        self.senderActorId = senderActorId
        self.kind = kind
        self.content = content
        self.createdAt = createdAt
        self.replyToMessageId = replyToMessageId
        self.mentions = mentions
    }

    public var isSystem: Bool { kind == "system" }
    public var isText: Bool { kind == "text" }
    public var mentionList: [String] {
        mentions.isEmpty ? [] : mentions.split(separator: ",").map(String.init)
    }
}
