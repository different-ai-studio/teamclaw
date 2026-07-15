import Foundation
import SwiftData

@Model
public final class CachedShortcut {
    @Attribute(.unique) public var shortcutId: String
    public var scope: String          // "personal" | "team"
    public var ownerMemberId: String? // present iff scope == "personal"
    public var teamId: String?        // present iff scope == "team"
    public var parentId: String?
    public var label: String
    public var icon: String?
    public var order: Int
    public var nodeType: String       // "native" | "link" | "folder"
    public var target: String
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        shortcutId: String,
        scope: String,
        ownerMemberId: String?,
        teamId: String?,
        parentId: String?,
        label: String,
        icon: String?,
        order: Int,
        nodeType: String,
        target: String,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.shortcutId = shortcutId
        self.scope = scope
        self.ownerMemberId = ownerMemberId
        self.teamId = teamId
        self.parentId = parentId
        self.label = label
        self.icon = icon
        self.order = order
        self.nodeType = nodeType
        self.target = target
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
