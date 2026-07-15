import Foundation

public protocol WorkspaceRepository: Sendable {
    func listWorkspaces(teamID: String, agentID: String?) async throws -> [WorkspaceRecord]
}
