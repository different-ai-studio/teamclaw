import Foundation
import Testing
@testable import AMUXCore

@Suite("AppOnboardingCoordinator")
struct AppOnboardingCoordinatorTests {

    @MainActor
    @Test("bootstrap routes users without teams to create team")
    func bootstrapWithoutTeamsShowsCreateTeam() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: [])
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.bootstrap()

        #expect(await store.recordedEnsureSessionCallCount() == 1)
        #expect(coordinator.route == .createTeam)
        #expect(coordinator.currentContext == nil)
    }

    @MainActor
    @Test("bootstrap routes users with a team into the app")
    func bootstrapWithTeamShowsApp() async throws {
        let team = TeamSummary(
            id: "team-1",
            name: "Alpha",
            slug: "alpha",
            role: "owner"
        )
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: "member-1", teams: [team])
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.bootstrap()

        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-1")
        #expect(coordinator.currentContext?.memberActorID == "member-1")
    }

    @MainActor
    @Test("create team transitions into ready")
    func createTeamTransitionsToReady() async throws {
        let created = CreatedTeam(
            team: TeamSummary(id: "team-2", name: "Beta", slug: "beta", role: "owner"),
            memberActorID: "member-2",
            workspaceID: "workspace-1",
            workspaceName: "General"
        )
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: []),
            createdTeam: created
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.bootstrap()
        await coordinator.createTeam(named: "Beta")

        #expect(await store.recordedCreatedTeamNames() == ["Beta"])
        #expect(coordinator.route == .ready)
        #expect(coordinator.currentContext?.team.id == "team-2")
    }

    @MainActor
    @Test("blank team names are rejected without store calls")
    func blankTeamNamesAreRejected() async throws {
        let store = InMemoryOnboardingStore(
            bootstrap: AppBootstrap(memberActorID: nil, teams: [])
        )
        let coordinator = AppOnboardingCoordinator(store: store)

        await coordinator.bootstrap()
        await coordinator.createTeam(named: "   ")

        #expect(await store.recordedCreatedTeamNames().isEmpty)
        #expect(coordinator.route == .createTeam)
        #expect(coordinator.errorMessage == "Team name is required.")
    }
}

private actor InMemoryOnboardingStore: AppOnboardingStore {
    let bootstrapResult: AppBootstrap
    let createdTeamResult: CreatedTeam?
    var ensureSessionCallCount = 0
    var createdTeamNames: [String] = []

    init(bootstrap: AppBootstrap, createdTeam: CreatedTeam? = nil) {
        self.bootstrapResult = bootstrap
        self.createdTeamResult = createdTeam
    }

    func ensureSession() async throws {
        ensureSessionCallCount += 1
    }

    func loadBootstrap() async throws -> AppBootstrap {
        bootstrapResult
    }

    func createTeam(named name: String) async throws -> CreatedTeam {
        createdTeamNames.append(name)
        if let createdTeamResult {
            return createdTeamResult
        }
        throw InMemoryError.missingCreatedTeam
    }

    func recordedEnsureSessionCallCount() -> Int {
        ensureSessionCallCount
    }

    func recordedCreatedTeamNames() -> [String] {
        createdTeamNames
    }

    // MARK: - Auth stub methods (not used in tests)

    func signIn(email: String, password: String) async throws {
        // no-op
    }

    func signUp(email: String, password: String) async throws {
        // no-op
    }

    func sendEmailOTP(email: String) async throws {
        // no-op
    }

    func verifyOTP(email: String, token: String) async throws {
        // no-op
    }

    func signInWithAppleCredential(idToken: String, nonce: String) async throws {
        // no-op
    }

    func signInWithGoogle() async throws {
        // no-op
    }

    func handleAuthCallback(url: URL) async throws {
        // no-op
    }

    func accessToken() async throws -> String {
        ""
    }

    func signOut() async throws {
        // no-op
    }

    func signInAnonymously() async throws {
        // no-op
    }

    func isAnonymous() async -> Bool { false }

    func upgradeWithPassword(email: String, password: String) async throws {
        // no-op
    }

    func upgradeWithAppleCredential(idToken: String, nonce: String) async throws {
        // no-op
    }

    func claimInvite(token: String) async throws -> ClaimResult {
        throw InMemoryError.claimNotConfigured
    }

    func setSession(refreshToken: String) async throws {
        // no-op
    }

    nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        AsyncStream { $0.finish() }
    }

    enum InMemoryError: Error {
        case missingCreatedTeam
        case claimNotConfigured
    }
}
