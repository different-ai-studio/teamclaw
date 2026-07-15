import Foundation

public struct WorkspaceRecord: Equatable, Sendable, Identifiable {
    public let id: String
    public let teamID: String
    public let agentID: String?
    public let path: String
    public let displayName: String

    public init(id: String, teamID: String, agentID: String?, path: String, displayName: String) {
        self.id = id
        self.teamID = teamID
        self.agentID = agentID
        self.path = path
        self.displayName = displayName
    }
}
