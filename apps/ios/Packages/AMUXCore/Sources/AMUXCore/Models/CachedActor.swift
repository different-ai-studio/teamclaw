import Foundation
import SwiftData

@Model
public final class CachedActor {
    @Attribute(.unique) public var actorId: String
    public var teamId: String
    public var actorType: String
    public var userId: String?
    public var invitedByActorId: String?
    public var displayName: String
    public var avatarURL: String?
    public var lastActiveAt: Date?
    public var createdAt: Date
    public var updatedAt: Date
    public var memberStatus: String?
    public var teamRole: String?
    public var agentTypes: [String]
    public var agentKind: String?
    public var defaultAgentType: String?
    public var agentStatus: String?
    public var defaultWorkspaceId: String?

    // Member contact — nil for agents and anonymous members.
    public var email: String?
    public var phone: String?

    public init(
        actorId: String, teamId: String, actorType: String,
        userId: String? = nil, invitedByActorId: String? = nil,
        displayName: String, avatarURL: String? = nil, lastActiveAt: Date? = nil,
        createdAt: Date = .now, updatedAt: Date = .now,
        memberStatus: String? = nil, teamRole: String? = nil,
        agentTypes: [String] = [], agentKind: String? = nil, defaultAgentType: String? = nil,
        agentStatus: String? = nil, defaultWorkspaceId: String? = nil,
        email: String? = nil, phone: String? = nil
    ) {
        self.actorId = actorId; self.teamId = teamId; self.actorType = actorType
        self.userId = userId; self.invitedByActorId = invitedByActorId
        self.displayName = displayName; self.avatarURL = avatarURL; self.lastActiveAt = lastActiveAt
        self.createdAt = createdAt; self.updatedAt = updatedAt
        self.memberStatus = memberStatus; self.teamRole = teamRole
        self.agentTypes = agentTypes; self.agentKind = agentKind; self.defaultAgentType = defaultAgentType
        self.agentStatus = agentStatus; self.defaultWorkspaceId = defaultWorkspaceId
        self.email = email; self.phone = phone
    }

    public var isMember: Bool { actorType == "member" }
    public var isAgent: Bool  { actorType == "agent" }
    public var isOwner: Bool  { teamRole == "owner" }
    public var isOnline: Bool {
        guard let last = lastActiveAt else { return false }
        return Date().timeIntervalSince(last) < 90
    }
    public var roleLabel: String {
        switch teamRole {
        case "owner":  return "Owner"
        case "admin":  return "Admin"
        case "member": return "Member"
        default:       return "—"
        }
    }
}
