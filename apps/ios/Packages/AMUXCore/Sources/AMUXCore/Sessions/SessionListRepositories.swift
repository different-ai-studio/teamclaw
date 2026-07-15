import Foundation

// Protocols + record types for the session-list / messages / runtimes
// repositories. Relocated out of the deleted Supabase implementations;
// the Cloud API implementations live in CloudAPI/CloudAPIRepositories.swift.


public struct SessionRecord: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let ideaID: String?
    public let createdByActorID: String
    public let primaryAgentID: String?
    public let mode: String
    public let title: String
    public let summary: String
    public let participantCount: Int
    public let lastMessagePreview: String
    public let lastMessageAt: Date?
    public let createdAt: Date
}

public protocol SessionsRepository: Sendable {
    func listSessions(teamID: String) async throws -> [SessionRecord]
    /// Returns the `(session_id, has_unread)` map computed server-side by
    /// `list_current_actor_sessions` (sessions.last_message_at > session_read_markers.last_read_at).
    /// Used by the inbox red-dot feature to authoritatively know which
    /// sessions have unseen peer messages without each client tracking the
    /// state locally.
    func fetchUnreadFlags(limit: Int) async throws -> [String: Bool]
    /// Marks the current actor as having viewed `sessionId` up to
    /// `lastReadMessageId`. Server upserts `session_read_markers` so other
    /// devices' next `fetchUnreadFlags` reflects the read.
    func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws
    /// Inverse of `markSessionViewed`: rewinds the actor's read marker so
    /// the session surfaces as unread again on every device's next
    /// `fetchUnreadFlags`. The actor is resolved server-side from the
    /// bearer token — no body.
    func markSessionUnread(sessionId: String) async throws
}



/// Fetches the canonical set of session IDs for a team from Supabase.
/// Used to filter out stale MQTT-era rows that still live in local SwiftData
/// but no longer exist in the authoritative backend.
public protocol SessionIDsRepository: Sendable {
    func listSessionIDs(teamID: String) async throws -> Set<String>
}



/// Snapshot of a Supabase `messages` row for the session-resume seed
/// path. Only the fields the iOS UI actually needs to render a past
/// turn (user prompt or finalized agent reply) are pulled — tool calls,
/// thinking deltas, and other intermediate ACP events are intentionally
/// not represented here.
public struct MessageRecord: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let sessionID: String
    public let senderActorID: String
    public let kind: String
    public let content: String
    public let createdAt: Date
    public let updatedAt: Date?
    /// Model id is currently stored inside `messages.metadata` JSON; not
    /// surfaced through the seed today. Left nil here until we add a typed
    /// metadata path.
    public let model: String?
    /// Daemon-assigned ACP turn correlation. Same value across rows the
    /// daemon flushed from one turn (ToolUse mid-stream causes a flush
    /// + a continuation flush at Active→Idle). The seed path uses this
    /// to merge those rows into a single bubble. nil for pre-turn_id
    /// rows or non-agent kinds.
    public let turnID: String?
    public let replyToMessageID: String?
    /// Chip-bar mentions the sender attached, decoded from
    /// `messages.metadata.mention_actor_ids`. Empty when the row carries
    /// no metadata — distinguishing directed from broadcast turns.
    public let mentionActorIDs: [String]
    /// Daemon-assigned per-runtime envelope sequence, stamped on every
    /// emit by `emit_agent_message`. Stable order across multi-runtime
    /// fanouts where `created_at` would collide. 0 means "legacy row
    /// before the column existed" — fall back to created_at ordering.
    public let sequence: Int64
}

/// Input shape for inserting a chat message into Supabase. iOS writes
/// human prompts here so collaborators on cold-launch get a complete
/// session history (the daemon only persists agent replies). RLS
/// `messages_insert_if_session_participant` gates on `sender_actor_id ==
/// app.current_actor_id()` and the caller's session-participant status.
public struct MessageInsertInput: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let sessionID: String
    public let senderActorID: String
    public let kind: String
    public let content: String
    /// Actor ids of chip-bar mentions. Stored in `messages.metadata` as
    /// `{"mention_actor_ids": [...]}` so the daemon can query historical
    /// routing context and the seed path can reconstruct directed vs
    /// broadcast turn groupings.
    public let mentionActorIDs: [String]

    public init(
        id: String = UUID().uuidString.lowercased(),
        teamID: String,
        sessionID: String,
        senderActorID: String,
        kind: String = "text",
        content: String,
        mentionActorIDs: [String] = []
    ) {
        self.id = id
        self.teamID = teamID
        self.sessionID = sessionID
        self.senderActorID = senderActorID
        self.kind = kind
        self.content = content
        self.mentionActorIDs = mentionActorIDs
    }
}

public protocol MessagesRepository: Sendable {
    func listForSession(sessionID: String) async throws -> [MessageRecord]
    func insert(_ input: MessageInsertInput) async throws
    /// Rewrites a persisted message's content. FC enforces sender-only
    /// semantics, so callers only offer this for the current actor's own
    /// rows — a 403 here is a programming error, not a user race.
    func patch(messageID: String, content: String) async throws
    /// Permanently removes a persisted message (FC returns 204).
    /// Same sender-only contract as `patch`.
    func delete(messageID: String) async throws
}



/// Snapshot of one row in the Supabase `agent_runtimes` table. Cached locally
/// as `CachedAgentRuntime` so the session list can display backend type +
/// workspace even when the daemon's MQTT runtime topic is offline.
public struct AgentRuntimeRecord: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let agentID: String
    public let sessionID: String?
    public let workspaceID: String?
    public let backendType: String
    public let status: String
    public let backendSessionID: String?
    /// Daemon-side 8-char runtime id (the segment in the MQTT topic
    /// `runtime/{runtime_id}/state`). The bridge to the live SwiftData
    /// `Runtime` row — distinct from `backendSessionID`, which is the
    /// 36-char ACP session id used by the daemon to resume Claude Code.
    public let runtimeID: String?
    public let currentModel: String?
    public let lastSeenAt: Date?
    public let createdAt: Date
    public let updatedAt: Date
}

public protocol AgentRuntimesRepository: Sendable {
    func listForTeam(teamID: String) async throws -> [AgentRuntimeRecord]
}

