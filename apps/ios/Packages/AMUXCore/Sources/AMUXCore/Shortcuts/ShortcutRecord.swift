import Foundation

public enum ShortcutScope: String, Codable, Equatable, Sendable {
    case personal
    case team
}

public enum ShortcutNodeType: String, Codable, Equatable, Sendable {
    case native
    case link
    case folder
}

public struct ShortcutRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let scope: ShortcutScope
    public let ownerMemberID: String?
    public let teamID: String?
    public let parentID: String?
    public var label: String
    public var icon: String?
    public var order: Int
    public var type: ShortcutNodeType
    public var target: String
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        scope: ShortcutScope,
        ownerMemberID: String?,
        teamID: String?,
        parentID: String?,
        label: String,
        icon: String?,
        order: Int,
        type: ShortcutNodeType,
        target: String,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.scope = scope
        self.ownerMemberID = ownerMemberID
        self.teamID = teamID
        self.parentID = parentID
        self.label = label
        self.icon = icon
        self.order = order
        self.type = type
        self.target = target
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
