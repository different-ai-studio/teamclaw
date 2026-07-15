import Testing
@testable import AMUXCore

@Suite("WorkspaceStore")
struct WorkspaceStoreTests {

    @MainActor
    @Test("reload lists only the selected agent's workspaces from the repository")
    func reloadListsAgentWorkspaces() async {
        let repository = InMemoryWorkspaceRepository(
            workspaces: [
                WorkspaceRecord(id: "ws-1", teamID: "team-1", agentID: "agent-a", path: "/tmp/a", displayName: "A"),
                WorkspaceRecord(id: "ws-2", teamID: "team-1", agentID: "agent-b", path: "/tmp/b", displayName: "B")
            ]
        )
        let store = WorkspaceStore(teamID: "team-1", repository: repository)

        await store.reload(agentID: "agent-a")

        #expect(store.workspaces.map(\.id) == ["ws-1"])
        #expect(store.errorMessage == nil)
    }

    @MainActor
    @Test("reload surfaces repository failures")
    func reloadSurfacesRepositoryFailures() async {
        let repository = InMemoryWorkspaceRepository(
            workspaces: [],
            error: InMemoryWorkspaceRepository.RepositoryError.failed
        )
        let store = WorkspaceStore(teamID: "team-1", repository: repository)

        await store.reload(agentID: "agent-a")

        #expect(store.workspaces.isEmpty)
        #expect(store.errorMessage != nil)
    }
}

private actor InMemoryWorkspaceRepository: WorkspaceRepository {
    enum RepositoryError: Error {
        case failed
    }

    let workspaces: [WorkspaceRecord]
    let error: Error?

    init(workspaces: [WorkspaceRecord], error: Error? = nil) {
        self.workspaces = workspaces
        self.error = error
    }

    func listWorkspaces(teamID: String, agentID: String?) async throws -> [WorkspaceRecord] {
        if let error {
            throw error
        }
        return workspaces.filter { workspace in
            workspace.teamID == teamID && workspace.agentID == agentID
        }
    }
}
