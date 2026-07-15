import SwiftData
import Testing
@testable import AMUXCore

@Suite("OnboardingLocalCacheBootstrapper")
struct OnboardingLocalCacheBootstrapperTests {

    @MainActor
    @Test("ensureWorkspaceExists leaves workspace cache empty")
    func ensureWorkspaceExistsLeavesWorkspaceCacheEmpty() throws {
        let container = try ModelContainer(
            for: Workspace.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)
        let team = TeamSummary(
            id: "team-1",
            name: "Alpha",
            slug: "alpha",
            role: "owner"
        )

        OnboardingLocalCacheBootstrapper.ensureWorkspaceExists(team: team, modelContext: context)

        let workspaces = try context.fetch(FetchDescriptor<Workspace>())
        #expect(workspaces.isEmpty)
    }
}
