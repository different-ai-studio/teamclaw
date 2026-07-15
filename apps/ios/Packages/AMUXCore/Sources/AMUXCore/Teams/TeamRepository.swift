import Foundation

public struct TeamDetails: Equatable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
    public let createdAt: Date
    public let ownerDisplayName: String?
    public let orgName: String?

    public init(id: String, name: String, slug: String,
                createdAt: Date, ownerDisplayName: String?,
                orgName: String? = nil) {
        self.id = id; self.name = name; self.slug = slug
        self.createdAt = createdAt
        self.ownerDisplayName = ownerDisplayName
        self.orgName = orgName
    }
}

public protocol TeamRepository: Sendable {
    func loadDetails(teamID: String) async throws -> TeamDetails
}
