import Foundation
import Observation

@Observable
@MainActor
public final class ConnectedAgentsStore {
    public private(set) var agents: [ConnectedAgent] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any AgentAccessRepository

    public init(teamID: String, repository: any AgentAccessRepository) {
        self.teamID = teamID
        self.repository = repository
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            agents = try await repository.listConnectedAgents(teamID: teamID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public var hasOnlineAgent: Bool {
        agents.contains(where: \.isOnline)
    }

    @discardableResult
    public func shareToTeam(agentID: String) async -> Bool {
        do {
            try await repository.shareAgentToTeam(agentID: agentID)
            await reload()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    public func makePersonal(agentID: String) async -> Bool {
        do {
            try await repository.makeAgentPersonal(agentID: agentID)
            await reload()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}

@Observable
@MainActor
public final class AgentAuthorizedHumansStore {
    public private(set) var humans: [AgentAuthorizedHuman] = []
    public private(set) var isLoading = false
    public private(set) var canManage = false
    public var errorMessage: String?

    private let agentID: String
    private let teamID: String
    private let repository: any AgentAccessRepository

    public init(agentID: String, teamID: String, repository: any AgentAccessRepository) {
        self.agentID = agentID
        self.teamID = teamID
        self.repository = repository
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let humansTask = repository.listAuthorizedHumans(agentID: agentID)
            async let canManageTask = repository.canManageAuthorizedHumans(agentID: agentID)
            humans = try await humansTask
            canManage = try await canManageTask
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func grant(memberID: String, permissionLevel: String = "prompt") async -> Bool {
        do {
            try await repository.grantAuthorizedHuman(
                agentID: agentID,
                memberID: memberID,
                permissionLevel: permissionLevel
            )
            await reload()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
