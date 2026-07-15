import Foundation

public struct AvailableModel: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}
