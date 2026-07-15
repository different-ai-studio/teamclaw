import Foundation
import SwiftData

@MainActor
public enum IdeaCacheSynchronizer {
    public static func upsert(_ ideas: [IdeaRecord], modelContext: ModelContext) {
        for idea in ideas {
            upsert(idea, modelContext: modelContext)
        }

        try? modelContext.save()
    }

    public static func upsert(_ idea: IdeaRecord, modelContext: ModelContext) {
        let descriptor = FetchDescriptor<SessionIdea>(
            predicate: #Predicate { $0.ideaId == idea.id }
        )

        if let existing = try? modelContext.fetch(descriptor).first {
            existing.workspaceId = idea.workspaceID
            existing.title = idea.title
            existing.ideaDescription = idea.description
            existing.status = idea.status
            existing.createdBy = idea.createdByActorID
            existing.createdAt = idea.createdAt
            existing.archived = idea.archived
            existing.sortOrder = idea.sortOrder
        } else {
            modelContext.insert(
                SessionIdea(
                    ideaId: idea.id,
                    sessionId: "",
                    workspaceId: idea.workspaceID,
                    title: idea.title,
                    ideaDescription: idea.description,
                    status: idea.status,
                    parentIdeaId: "",
                    createdBy: idea.createdByActorID,
                    createdAt: idea.createdAt,
                    archived: idea.archived,
                    sortOrder: idea.sortOrder
                )
            )
        }
    }
}
