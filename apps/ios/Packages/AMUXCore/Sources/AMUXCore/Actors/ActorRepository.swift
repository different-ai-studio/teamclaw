import Foundation

public enum InviteKind: String, Codable, Sendable { case member, agent }
public enum TeamRole:   String, Codable, Sendable { case member, admin }

public struct InviteCreateInput: Equatable, Sendable {
    public let kind: InviteKind
    public let displayName: String
    public let teamRole: TeamRole?
    public let agentKind: String?
    public let ttlSeconds: Int
    /// When non-nil, the claim rotates credentials on this existing actor
    /// instead of creating a new one — the "re-invite" flow from
    /// ActorDetailView. Valid for `.agent`, and for `.member` when the
    /// target user is anonymous (`auth.users.is_anonymous = true`).
    public let targetActorID: String?

    public init(
        kind: InviteKind,
        displayName: String,
        teamRole: TeamRole? = nil,
        agentKind: String? = nil,
        ttlSeconds: Int = 604_800,
        targetActorID: String? = nil
    ) {
        self.kind = kind; self.displayName = displayName
        self.teamRole = teamRole; self.agentKind = agentKind
        self.ttlSeconds = ttlSeconds
        self.targetActorID = targetActorID
    }
}

public struct InviteCreated: Equatable, Sendable {
    public let token: String
    public let expiresAt: Date
    public let deeplink: String

    public init(token: String, expiresAt: Date, deeplink: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.deeplink = Self.teamclawDeeplink(from: deeplink)
    }

    private static func teamclawDeeplink(from deeplink: String) -> String {
        guard deeplink.hasPrefix("amux://") else { return deeplink }
        return "teamclaw://" + deeplink.dropFirst("amux://".count)
    }
}

public struct ClaimResult: Equatable, Sendable {
    public let actorID: String
    public let teamID: String
    public let actorType: String
    public let displayName: String
    public let refreshToken: String?   // non-nil only for kind='agent'

    public init(actorID: String, teamID: String, actorType: String,
                displayName: String, refreshToken: String?) {
        self.actorID = actorID; self.teamID = teamID
        self.actorType = actorType; self.displayName = displayName
        self.refreshToken = refreshToken
    }
}

public protocol ActorRepository: Sendable {
    func listActors(teamID: String) async throws -> [ActorRecord]
    func createInvite(teamID: String, input: InviteCreateInput) async throws -> InviteCreated
    func claimInvite(token: String) async throws -> ClaimResult
    func heartbeat() async throws
    func removeActor(actorID: String) async throws
}
