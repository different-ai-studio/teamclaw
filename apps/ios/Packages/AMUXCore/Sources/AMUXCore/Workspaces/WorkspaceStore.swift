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
}
