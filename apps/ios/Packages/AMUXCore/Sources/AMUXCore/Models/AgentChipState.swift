import Foundation

/// Chip-bar participant model for SessionDetailViewModel.
/// Lives in AMUXCore (no AMUXUI dep). AMUXUI translates this at the
/// view boundary (Task 16) into `AgentChipBar.AgentChip`.
public struct AgentChipParticipant: Identifiable, Equatable, Sendable {
    public let id: String           // agent_id (uuid)
    public let displayName: String
    public let lifecycleState: AgentLifecycleState

    public init(id: String, displayName: String, lifecycleState: AgentLifecycleState) {
        self.id = id
        self.displayName = displayName
        self.lifecycleState = lifecycleState
    }
}

public enum AgentLifecycleState: String, Equatable, Sendable, CaseIterable {
    case spawning, ready, idle, active, stopped, error
}

/// Participant descriptor passed to `SessionDetailViewModel.bootstrapChips`.
/// Holds the fields needed to build chip state: actor id, role, and display name.
/// This is the public model-layer counterpart to `SessionParticipantInput`
/// (which omits displayName). Views/coordinators construct these from
/// Supabase actor rows before calling bootstrapChips.
public struct SessionParticipant: Equatable, Sendable {
    public let actorID: String
    public let role: String
    public let displayName: String?

    public init(actorID: String, role: String, displayName: String? = nil) {
        self.actorID = actorID
        self.role = role
        self.displayName = displayName
    }
}
