import Foundation
import SwiftData

public enum OnboardingLocalCacheBootstrapper {
    public static func prime(createdTeam: CreatedTeam, modelContext: ModelContext) {
        upsertMember(actorID: createdTeam.memberActorID, modelContext: modelContext)
        try? modelContext.save()
    }

    public static func ensureWorkspaceExists(team: TeamSummary, modelContext: ModelContext) {
        _ = team
        _ = modelContext
    }

    private static func upsertMember(actorID: String, modelContext: ModelContext) {
        let descriptor = FetchDescriptor<CachedActor>(predicate: #Predicate { $0.actorId == actorID })
        if let existing = try? modelContext.fetch(descriptor).first {
            existing.displayName = existing.displayName.isEmpty ? "You" : existing.displayName
            existing.teamRole = "owner"
            return
        }

        modelContext.insert(
            CachedActor(
                actorId: actorID,
                teamId: "",
                actorType: "member",
                displayName: "You",
                memberStatus: "active",
                teamRole: "owner"
            )
        )
    }
}
