import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class ActorStoreTests: XCTestCase {

    private func makeContext() throws -> ModelContext {
        let schema = Schema([CachedActor.self])
        let c = try ModelContainer(for: schema,
                                   configurations: [ModelConfiguration(isStoredInMemoryOnly: true)])
        return ModelContext(c)
    }

    private func sampleMember(id: String = "a-1", name: String = "Alice") -> ActorRecord {
        ActorRecord(
            id: id, teamID: "t-1", actorType: "member",
            userID: "u-1", invitedByActorID: nil, displayName: name,
            lastActiveAt: Date(), createdAt: Date(), updatedAt: Date(),
            memberStatus: "active", teamRole: "member",
            agentKind: nil, agentStatus: nil
        )
    }

    func testReloadPopulates() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(actors: [sampleMember()])
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await store.reload()
        XCTAssertEqual(store.actors.count, 1)
        let cached = try ctx.fetch(FetchDescriptor<CachedActor>())
        XCTAssertEqual(cached.count, 1)
    }

    func testReloadFailureSetsError() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await repo.setNextError(URLError(.notConnectedToInternet))
        await store.reload()
        XCTAssertNotNil(store.errorMessage)
    }

    func testCreateMemberInvite() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(inviteCreated: InviteCreated(token: "tok",
                                                          expiresAt: Date().addingTimeInterval(3600),
                                                          deeplink: "teamclaw://invite?token=tok"))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let r = await store.createInvite(.init(kind: .member, displayName: "Bob", teamRole: .admin))
        XCTAssertEqual(r?.token, "tok")
        let lastInput = await repo.lastInviteInput
        XCTAssertEqual(lastInput?.kind, .member)
        XCTAssertEqual(lastInput?.teamRole, .admin)
    }

    func testCreateAgentInvite() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.configure(inviteCreated: InviteCreated(token: "tok-a", expiresAt: Date(),
                                                          deeplink: "teamclaw://invite?token=tok-a"))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        _ = await store.createInvite(.init(kind: .agent, displayName: "M1 Studio",
                                           agentKind: "daemon"))
        let lastInput = await repo.lastInviteInput
        XCTAssertEqual(lastInput?.kind, .agent)
        XCTAssertEqual(lastInput?.agentKind, "daemon")
    }

    func testClaimInviteSurfacesError() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        await repo.setNextError(NSError(domain: "Supabase", code: 0,
                                        userInfo: [NSLocalizedDescriptionKey: "invite expired"]))
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        let r = await store.claimInvite(token: "x")
        XCTAssertNil(r)
        XCTAssertEqual(store.errorMessage, "invite expired")
    }

    func testHeartbeatThrottled() async throws {
        let ctx = try makeContext()
        let repo = MockActorRepository()
        let store = ActorStore(teamID: "t-1", repository: repo, modelContext: ctx)
        await store.heartbeat(); await store.heartbeat(); await store.heartbeat()
        let count = await repo.heartbeatCallCount
        XCTAssertEqual(count, 1)
    }
}

private actor MockActorRepository: ActorRepository {
    private(set) var actorsToReturn: [ActorRecord] = []
    private(set) var inviteCreatedToReturn: InviteCreated?
    private(set) var claimResultToReturn: ClaimResult?
    private(set) var nextError: Error?
    private(set) var lastInviteInput: InviteCreateInput?
    private(set) var heartbeatCallCount: Int = 0

    func configure(actors: [ActorRecord] = [], inviteCreated: InviteCreated? = nil,
                   claimResult: ClaimResult? = nil) {
        actorsToReturn = actors
        inviteCreatedToReturn = inviteCreated
        claimResultToReturn = claimResult
    }

    func setNextError(_ error: Error) {
        nextError = error
    }

    func listActors(teamID: String) async throws -> [ActorRecord] {
        if let e = nextError { nextError = nil; throw e }
        return actorsToReturn
    }
    func createInvite(teamID: String, input: InviteCreateInput) async throws -> InviteCreated {
        lastInviteInput = input
        if let e = nextError { nextError = nil; throw e }
        return inviteCreatedToReturn
            ?? InviteCreated(token: "", expiresAt: Date(), deeplink: "")
    }
    func claimInvite(token: String) async throws -> ClaimResult {
        if let e = nextError { nextError = nil; throw e }
        return claimResultToReturn
            ?? ClaimResult(actorID: "", teamID: "", actorType: "member",
                           displayName: "", refreshToken: nil)
    }
    func heartbeat() async throws { heartbeatCallCount += 1 }
    func removeActor(actorID: String) async throws {
        if let e = nextError { nextError = nil; throw e }
    }
}
