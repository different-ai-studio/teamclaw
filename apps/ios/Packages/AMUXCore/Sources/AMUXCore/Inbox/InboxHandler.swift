import Foundation

// MARK: - Wire payload

/// Lightweight ping published by FC to `inbox/<user_id>` after a message
/// INSERT or a mark-viewed write. The `type` field disambiguates:
///   - nil / "message": a new message arrived — session is unread.
///   - "read": another device marked this session read — clear the badge.
public struct InboxPing: Equatable, Decodable, Sendable {
    public let sessionID: String
    public let type: String?
    public let ts: Int64?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case type
        case ts
    }
}

public enum InboxParseError: Error, Equatable, Sendable {
    /// Topic doesn't start with `inbox/`. Caller should pass this through to
    /// other handlers (not all MQTT traffic is for the inbox).
    case notInboxTopic
    /// Topic was `inbox/<other>` rather than `inbox/<expectedUserID>`. The
    /// broker ACL should already block this, but we defend anyway.
    case wrongUser(expected: String, got: String)
    /// Payload was not valid JSON or missing required fields.
    case malformedPayload
    /// Decoded JSON had an empty `session_id`.
    case missingSessionID
}

// MARK: - Pure parser

/// Returns the parsed `InboxPing` if the envelope is a well-formed inbox
/// ping addressed to this client. Side-effect free so it tests without
/// needing SwiftData, MQTT, or Supabase.
public func parseInboxEnvelope(
    topic: String,
    payload: Data,
    expectedUserID: String
) -> Result<InboxPing, InboxParseError> {
    let prefix = "inbox/"
    guard topic.hasPrefix(prefix) else { return .failure(.notInboxTopic) }
    let topicUser = String(topic.dropFirst(prefix.count))
    guard topicUser == expectedUserID else {
        return .failure(.wrongUser(expected: expectedUserID, got: topicUser))
    }
    do {
        let ping = try JSONDecoder().decode(InboxPing.self, from: payload)
        guard !ping.sessionID.isEmpty else { return .failure(.missingSessionID) }
        return .success(ping)
    } catch {
        return .failure(.malformedPayload)
    }
}
