import Foundation
import SwiftData

/// Snapshot of a Supabase `agent_runtimes` row, cached locally so the iOS
/// session list can display the real backend type and workspace even when the
/// daemon's MQTT-published `Runtime` row is offline.
///
/// Multiple runtimes can share the same `sessionId` over a session's lifetime
/// (stop → respawn, status transitions). Lookup by session picks the most
/// recently updated row.
@Model
public final class CachedAgentRuntime {
    @Attribute(.unique) public var id: String
    public var teamId: String
    public var agentId: String
    public var sessionId: String?
    public var workspaceId: String?
    /// "claude" | "codex" | "opencode"
    public var backendType: String
    /// "starting" | "running" | "idle" | "stopped" | "failed"
    public var status: String
    /// 36-char ACP session id used by the daemon to resume the Claude Code
    /// session. **Not** the bridge to the MQTT `Runtime` row — use
    /// `runtimeId` for that.
    public var backendSessionId: String?
    /// Daemon-side 8-char runtime id (the segment in MQTT topic
    /// `runtime/{runtime_id}/state`). Bridge to the live SwiftData `Runtime`
    /// row. Optional because rows written before the column existed have
    /// nil here; placeholder Runtime is used until the daemon re-upserts.
    public var runtimeId: String?
    public var currentModel: String?
    public var lastSeenAt: Date?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        teamId: String,
        agentId: String,
        sessionId: String? = nil,
        workspaceId: String? = nil,
        backendType: String,
        status: String,
        backendSessionId: String? = nil,
        runtimeId: String? = nil,
        currentModel: String? = nil,
        lastSeenAt: Date? = nil,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.teamId = teamId
        self.agentId = agentId
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.backendType = backendType
        self.status = status
        self.backendSessionId = backendSessionId
        self.runtimeId = runtimeId
        self.currentModel = currentModel
        self.lastSeenAt = lastSeenAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
