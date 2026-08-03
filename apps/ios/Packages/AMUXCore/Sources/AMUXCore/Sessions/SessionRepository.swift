import Foundation

public struct SessionParticipantInput: Equatable, Sendable {
    public let actorID: String
    public let role: String?

    public init(actorID: String, role: String? = nil) {
        self.actorID = actorID
        self.role = role
    }
}

public struct SessionCreateInput: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let ideaID: String?
    public let createdByActorID: String
    public let primaryAgentID: String?
    public let mode: String
    public let title: String
    public let summary: String
    public let participants: [SessionParticipantInput]

    public init(
        id: String,
        teamID: String,
        ideaID: String? = nil,
        createdByActorID: String,
        primaryAgentID: String? = nil,
        mode: String = "collab",
        title: String,
        summary: String,
        participants: [SessionParticipantInput]
    ) {
        self.id = id
        self.teamID = teamID
        self.ideaID = ideaID
        self.createdByActorID = createdByActorID
        self.primaryAgentID = primaryAgentID
        self.mode = mode
        self.title = title
        self.summary = summary
        self.participants = participants
    }
}

public struct SessionParticipantRecord: Equatable, Sendable {
    public let id: String
    public let sessionID: String
    public let actorID: String
    public let role: String?               // "human" | "agent" | nil
    public let displayName: String
    public let actorType: String           // "human" | "agent"
    /// Agent's workspace for this session; nil on member rows. Replaces the
    /// team-wide `agent_runtimes` fetch this used to be joined against.
    public let workspaceID: String?
    /// Agent's model for this session; nil on member rows.
    public let model: String?

    public init(id: String, sessionID: String, actorID: String, role: String?,
                displayName: String, actorType: String,
                workspaceID: String? = nil, model: String? = nil) {
        self.id = id
        self.sessionID = sessionID
        self.actorID = actorID
        self.role = role
        self.workspaceID = workspaceID
        self.model = model
        self.displayName = displayName
        self.actorType = actorType
    }
}

public protocol SessionRepository: Sendable {
    func createSession(_ input: SessionCreateInput) async throws
    func addParticipants(sessionID: String, actorIDs: [String]) async throws
    func listSessionParticipants(sessionID: String) async throws -> [SessionParticipantRecord]
    func removeParticipant(sessionID: String, actorID: String) async throws
}

public enum SessionRepositoryError: LocalizedError {
    case missingTitle
    case missingParticipants

    public var errorDescription: String? {
        switch self {
        case .missingTitle:
            return "Session title is required."
        case .missingParticipants:
            return "Session participants are required."
        }
    }
}
