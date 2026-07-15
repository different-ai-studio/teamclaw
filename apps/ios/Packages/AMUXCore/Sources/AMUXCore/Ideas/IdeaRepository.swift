import Foundation

public protocol IdeaRepository: Sendable {
    func listIdeas(teamID: String) async throws -> [IdeaRecord]
    func createIdea(teamID: String, input: IdeaCreateInput) async throws -> IdeaRecord
    func updateIdea(ideaID: String, input: IdeaUpdateInput) async throws -> IdeaRecord
    func setArchived(ideaID: String, archived: Bool) async throws -> IdeaRecord
    func reorderIdeas(teamID: String, ideaIDs: [String]) async throws
    func listIdeaActivities(ideaID: String) async throws -> [IdeaActivityRecord]
    func createIdeaActivity(ideaID: String, input: IdeaActivityCreateInput) async throws -> IdeaActivityRecord
}

public enum IdeaRepositoryError: LocalizedError {
    case missingTitle
    case emptyResponse(String)

    public var errorDescription: String? {
        switch self {
        case .missingTitle:
            return "Title is required."
        case .emptyResponse(let functionName):
            return "\(functionName) returned no rows."
        }
    }
}
