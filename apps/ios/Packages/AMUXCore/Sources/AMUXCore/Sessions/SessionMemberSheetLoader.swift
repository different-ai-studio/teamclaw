import Foundation

// MARK: - Snapshot models

public struct MemberSheetHuman: Identifiable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let isOnline: Bool
    public let canRemove: Bool

    public init(id: String, displayName: String, isOnline: Bool, canRemove: Bool) {
        self.id = id
        self.displayName = displayName
        self.isOnline = isOnline
        self.canRemove = canRemove
    }
}

public struct MemberSheetAgent: Identifiable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let workspacePath: String
    public let agentType: String
    public let runtimeState: AgentRuntimeChipState
    public let availableModels: [String]
    public let currentModel: String?
    /// Daemon-side 8-char runtime id (segment in
    /// `runtime/{runtime_id}/state`). Nil when the agent participates
    /// in this session without a live runtime row yet — `removeAgent`
    /// skips `runtimeStopRpc` in that case and only does the Supabase
    /// delete.
    public let runtimeID: String?
    /// Workspace UUID from the `agent_runtimes.workspace_id` column —
    /// authoritative key for resolving the worktree filesystem path on
    /// restart. Distinct from `workspacePath` which currently still
    /// holds the same UUID for legacy display reasons.
    public let workspaceID: String?
    /// Backend type spelling stored in `agent_runtimes.backend_type`
    /// ("claude" / "opencode" / "codex"). Used to map to
    /// `Amux_AgentType` for `runtimeStartRpc` on restart. Distinct from
    /// `agentType` which carries the capitalized display name.
    public let backendType: String?

    public init(id: String, displayName: String, workspacePath: String, agentType: String,
                runtimeState: AgentRuntimeChipState, availableModels: [String],
                currentModel: String?, runtimeID: String?, workspaceID: String?,
                backendType: String?) {
        self.id = id
        self.displayName = displayName
        self.workspacePath = workspacePath
        self.agentType = agentType
        self.runtimeState = runtimeState
        self.availableModels = availableModels
        self.currentModel = currentModel
        self.runtimeID = runtimeID
        self.workspaceID = workspaceID
        self.backendType = backendType
    }
}

public struct SessionMemberSheetSnapshot: Equatable, Sendable {
    public let humans: [MemberSheetHuman]
    public let agents: [MemberSheetAgent]

    public init(humans: [MemberSheetHuman], agents: [MemberSheetAgent]) {
        self.humans = humans
        self.agents = agents
    }
}

// MARK: - Loader

/// Pulls the member sheet's snapshot data — Supabase
/// `session_participants` joined with `agent_runtimes` — and shapes it
/// into the per-row view-model structs. Extracted from
/// `SessionDetailViewModel.refreshMemberSheet` so the I/O and shaping
/// logic is testable without an `@MainActor @Observable` VM and the
/// cross-cutting chip-bar auto-light rule can stay where it belongs
/// (on the VM, which owns `agentChipSelection`).
public struct SessionMemberSheetLoader: Sendable {
    public let sessionsRepository: SessionRepository?
    public let agentRuntimesRepository: AgentRuntimesRepository?

    public init(sessionsRepository: SessionRepository?,
                agentRuntimesRepository: AgentRuntimesRepository?) {
        self.sessionsRepository = sessionsRepository
        self.agentRuntimesRepository = agentRuntimesRepository
    }

    /// Fetches participants + per-agent runtime rows and shapes them
    /// into a snapshot. Returns nil on a hard fetch failure (caller
    /// keeps prior values displayed); the result is non-optional once
    /// the participants fetch succeeds, even when the agent_runtimes
    /// fetch fails — the agent rows just lack runtime metadata.
    ///
    /// - Parameters:
    ///   - availableModelsForAgent: closure that returns the cached
    ///     model list for a given agent actor id. The loader doesn't
    ///     hold this state (it lives on the VM's bound runtime), so
    ///     the VM passes a closure.
    public func load(
        sessionID: String,
        teamID: String,
        currentHumanActorID: String,
        availableModelsForAgent: @Sendable (String) -> [String]
    ) async -> SessionMemberSheetSnapshot? {
        guard let sessionsRepo = sessionsRepository else { return nil }

        let participants: [SessionParticipantRecord]
        do {
            participants = try await sessionsRepo.listSessionParticipants(sessionID: sessionID)
        } catch {
            return nil
        }

        var sessionRuntimes: [AgentRuntimeRecord] = []
        if !teamID.isEmpty, let runtimesRepo = agentRuntimesRepository {
            if let all = try? await runtimesRepo.listForTeam(teamID: teamID) {
                sessionRuntimes = all.filter { $0.sessionID == sessionID }
            }
        }

        let humans: [MemberSheetHuman] = participants
            .filter { $0.actorType != "agent" }
            .map { p in
                MemberSheetHuman(
                    id: p.actorID,
                    displayName: p.displayName,
                    isOnline: true,
                    canRemove: !currentHumanActorID.isEmpty && p.actorID != currentHumanActorID
                )
            }

        let agents: [MemberSheetAgent] = participants
            .filter { $0.actorType == "agent" }
            .map { p in
                let runtime = sessionRuntimes.first(where: { $0.agentID == p.actorID })
                let liveModels = availableModelsForAgent(p.actorID)
                return MemberSheetAgent(
                    id: p.actorID,
                    displayName: p.displayName,
                    workspacePath: runtime?.workspaceID ?? "",
                    agentType: Self.displayName(forBackendType: runtime?.backendType),
                    runtimeState: Self.chipState(forStatus: runtime?.status,
                                                 lastSeenAt: runtime?.lastSeenAt),
                    availableModels: liveModels,
                    currentModel: runtime?.currentModel,
                    runtimeID: runtime?.runtimeID,
                    workspaceID: runtime?.workspaceID,
                    backendType: runtime?.backendType
                )
            }

        return SessionMemberSheetSnapshot(humans: humans, agents: agents)
    }

    // MARK: - Status/display helpers (moved from SessionDetailViewModel)

    /// Combine the raw `agent_runtimes.status` string with `last_seen_at`
    /// to produce the chip state. Some ACP backends (Claude Haiku in
    /// particular) don't emit a StatusChange:Active event between the
    /// initial spawn and the first user prompt, so the daemon-side
    /// `starting` status sticks to the row indefinitely. Without
    /// freshness gating the chip bar reads "spawning forever" even
    /// though the runtime is fully alive. Demote stale spawning rows
    /// to `.idle` (gray, no spinner) once `last_seen_at` is older than
    /// 30 seconds.
    public static func chipState(forStatus status: String?,
                                 lastSeenAt: Date?,
                                 now: Date = Date(),
                                 spawnTimeout: TimeInterval = 30) -> AgentRuntimeChipState {
        let raw = fromRuntimeStatus(status)
        guard raw == .spawning else { return raw }
        guard let last = lastSeenAt else { return raw }
        return now.timeIntervalSince(last) > spawnTimeout ? .idle : raw
    }

    /// Maps the daemon-published status string on `agent_runtimes.status`
    /// (see `daemon/src/runtime/manager.rs` and
    /// `daemon/src/daemon/server.rs`) to a chip state used by the
    /// member sheet and chip bar.
    public static func fromRuntimeStatus(_ status: String?) -> AgentRuntimeChipState {
        switch status {
        case "starting", "spawning": return .spawning
        case "ready": return .ready
        case "running", "active": return .active
        case "idle": return .idle
        case "stopped": return .stopped
        case "error": return .error
        default: return .idle
        }
    }

    /// Human-readable backend type for the chip's subtitle line.
    public static func displayName(forBackendType backendType: String?) -> String {
        switch backendType {
        case "claude": return "Claude"
        case "opencode": return "OpenCode"
        case "codex": return "Codex"
        case .some(let s) where !s.isEmpty: return s.capitalized
        default: return ""
        }
    }

}
