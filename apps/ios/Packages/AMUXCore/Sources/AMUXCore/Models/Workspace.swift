import Foundation
import SwiftData

@Model
public final class Workspace {
    @Attribute(.unique) public var workspaceId: String
    public var path: String
    public var displayName: String

    public init(workspaceId: String, path: String, displayName: String) {
        self.workspaceId = workspaceId
        self.path = path
        self.displayName = displayName
    }
}
