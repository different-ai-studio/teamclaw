import Foundation
import Testing
@testable import AMUXCore

@Suite("AgentAuthorizedHumansStore")
struct AgentAuthorizedHumansStoreTests {

    @MainActor
    @Test("reload fetches authorized members and manager permission")
    func reloadFetchesMembersAndManagerPermission() async {
        let repository = InMemoryAgentAccessRepository(
            authorizedHumans: [
                AgentAuthorizedHuman(
                    id: "member-1",
                    displayName: "Alice",
                    permissionLevel: "prompt",
                    grantedByActorID: "owner-1",
                    lastActiveAt: nil
                )
            ],
            canManage: true
        )
        let store = AgentAuthorizedHumansStore(
            agentID: "agent-1",
            teamID: "team-1",
            repository: repository
        )

        await store.reload()

        #expect(store.humans.map(\.id) == ["member-1"])
        #expect(store.canManage)
        #expect(store.errorMessage == nil)
    }

    @MainActor
    @Test("grant upserts access then refreshes the list")
    func grantRefreshesAuthorizedMembers() async {
        let repository = InMemoryAgentAccessRepository(
            authorizedHumans: [],
            canManage: true
        )
        let store = AgentAuthorizedHumansStore(
            agentID: "agent-1",
            teamID: "team-1",
            repository: repository
        )

        let ok = await store.grant(memberID: "member-2")

        #expect(ok)
        #expect(store.humans.map(\.id) == ["member-2"])
        #expect(await repository.grantedMemberID() == "member-2")
    }
}

private actor InMemoryAgentAccessRepository: AgentAccessRepository {
    var authorizedHumans: [AgentAuthorizedHuman]
    let canManageValue: Bool
    var lastGrantedMemberID: String?

    init(authorizedHumans: [AgentAuthorizedHuman], canManage: Bool) {
        self.authorizedHumans = authorizedHumans
        self.canManageValue = canManage
    }

    func listConnectedAgents(teamID: String) async throws -> [ConnectedAgent] {
        []
    }

    func listAuthorizedHumans(agentID: String) async throws -> [AgentAuthorizedHuman] {
        authorizedHumans
    }

    func canManageAuthorizedHumans(agentID: String) async throws -> Bool {
        canManageValue
    }

    func shareAgentToTeam(agentID: String) async throws {}

    func makeAgentPersonal(agentID: String) async throws {}

    func teamAgentCount(teamID: String) async throws -> Int {
        0
    }

    func grantAuthorizedHuman(agentID: String, memberID: String, permissionLevel: String) async throws {
        lastGrantedMemberID = memberID
        authorizedHumans.append(
            AgentAuthorizedHuman(
                id: memberID,
                displayName: "Granted",
                permissionLevel: permissionLevel,
                grantedByActorID: "owner-1",
                lastActiveAt: nil
            )
        )
    }

    func grantedMemberID() -> String? {
        lastGrantedMemberID
    }
}
