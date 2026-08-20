import Foundation
import Observation

@Observable
@MainActor
public final class WorkspaceStore {
    public private(set) var workspaces: [WorkspaceRecord] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any WorkspaceRepository

    public init(teamID: String, repository: any WorkspaceRepository) {
        self.teamID = teamID
        self.repository = repository
    }

    public func reload(agentID: String?) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            workspaces = try await repository.listWorkspaces(teamID: teamID, agentID: agentID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Registers a workspace directory for an agent via the Cloud API
    /// (`POST /v1/workspaces` upsert), then reloads the list. Returns false
    /// (with `errorMessage` set) on failure. Replaces the deprecated
    /// `add_workspace` daemon RPC.
    public func add(path: String, agentID: String) async -> Bool {
        do {
            _ = try await repository.createWorkspace(teamID: teamID, agentID: agentID, path: path)
            errorMessage = nil
            await reload(agentID: agentID)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
