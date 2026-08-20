import Foundation

public protocol WorkspaceRepository: Sendable {
    func listWorkspaces(teamID: String, agentID: String?) async throws -> [WorkspaceRecord]
    /// Creates (or upserts) a daemon workspace via `POST /v1/workspaces`.
    /// Replaces the deprecated `add_workspace` RPC — per the proto,
    /// workspaces are created in the cloud and the daemon resolves
    /// workspace UUID→path from there.
    func createWorkspace(teamID: String, agentID: String, path: String) async throws -> WorkspaceRecord
}
