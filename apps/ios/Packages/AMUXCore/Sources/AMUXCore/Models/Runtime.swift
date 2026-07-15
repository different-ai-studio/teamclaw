import Foundation
import SwiftData

@Model
public final class Runtime {
    @Attribute(.unique) public var runtimeId: String
    public var agentType: Int
    public var worktree: String
    public var branch: String
    public var status: Int
    public var startedAt: Date
    public var currentPrompt: String
    public var workspaceId: String
    public var sessionTitle: String
    public var lastEventSummary: String
    public var lastEventTime: Date?
    public var lastOutputSummary: String
    public var toolUseCount: Int
    public var hasUnread: Bool
    /// Stored as JSON because SwiftData doesn't store [Codable] arrays cleanly.
    /// Read via the `availableModels` extension; refactor to a @Model relationship
    /// if the model list grows beyond the daemon-hardcoded handful.
    public var availableModelsJSON: String = ""
    public var currentModel: String?
    /// Most recent slash commands the daemon reported on the retained
    /// `runtime/{id}/state` topic. Populated by `SessionListViewModel.syncRuntime`
    /// from `Amux_RuntimeInfo.available_commands` so detail views can seed
    /// the slash popup before the (non-retained) events stream replays the
    /// next `AvailableCommandsUpdate`. JSON-encoded `[SlashCommand]`.
    public var availableCommandsJSON: String = ""

    /// Routing actor id of the daemon/agent that owns this runtime — populated
    /// from the topic path when SessionListVM ingests `runtime/{rid}/state`.
    /// Used by RuntimeDetailVM to publish commands to the right
    /// `amux/{team}/{actor}/runtime/{rid}/commands` topic without needing a
    /// Session row alongside.
    public var routeActorID: String = ""

    public init(runtimeId: String, agentType: Int = 1, worktree: String = "", branch: String = "",
                status: Int = 1, startedAt: Date = .now, currentPrompt: String = "",
                workspaceId: String = "") {
        self.runtimeId = runtimeId
        self.agentType = agentType
        self.worktree = worktree
        self.branch = branch
        self.status = status
        self.startedAt = startedAt
        self.currentPrompt = currentPrompt
        self.workspaceId = workspaceId
        self.sessionTitle = ""
        self.lastEventSummary = ""
        self.lastEventTime = nil
        self.lastOutputSummary = ""
        self.toolUseCount = 0
        self.hasUnread = false
    }

    public var isActive: Bool { status == 2 }
    public var isIdle: Bool { status == 3 }
    public var statusLabel: String {
        switch status {
        case 1: "Starting"
        case 2: "Active"
        case 3: "Idle"
        case 4: "Error"
        case 5: "Stopped"
        default: "Unknown"
        }
    }
    public var agentTypeLabel: String {
        switch agentType {
        case 1: "Claude Code"
        case 2: "OpenCode"
        case 3: "Codex"
        default: "Unknown"
        }
    }
}

public extension Runtime {
    var availableModels: [AvailableModel] {
        guard !availableModelsJSON.isEmpty,
              let data = availableModelsJSON.data(using: .utf8),
              let models = try? JSONDecoder().decode([AvailableModel].self, from: data)
        else { return [] }
        return models
    }

    var availableCommands: [SlashCommand] {
        guard !availableCommandsJSON.isEmpty,
              let data = availableCommandsJSON.data(using: .utf8),
              let cmds = try? JSONDecoder().decode([SlashCommand].self, from: data)
        else { return [] }
        return cmds
    }
}
