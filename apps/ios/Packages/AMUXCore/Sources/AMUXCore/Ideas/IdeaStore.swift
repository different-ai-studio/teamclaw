import Foundation
import Observation
import SwiftData

@Observable
@MainActor
public final class IdeaStore {
    public private(set) var ideas: [IdeaRecord] = []
    public private(set) var archivedIdeas: [IdeaRecord] = []
    public private(set) var activitiesByIdeaID: [String: [IdeaActivityRecord]] = [:]
    public private(set) var isLoading = false
    public private(set) var isLoadingActivities = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any IdeaRepository
    private let modelContext: ModelContext

    public init(teamID: String, repository: any IdeaRepository, modelContext: ModelContext) {
        self.teamID = teamID
        self.repository = repository
        self.modelContext = modelContext
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            let remoteIdeas = try await repository.listIdeas(teamID: teamID)
            apply(remoteIdeas)
            IdeaCacheSynchronizer.upsert(remoteIdeas, modelContext: modelContext)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func createIdea(title: String, description: String, workspaceID: String) async -> Bool {
        do {
            let created = try await repository.createIdea(
                teamID: teamID,
                input: IdeaCreateInput(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                    workspaceID: workspaceID
                )
            )
            merge(created)
            IdeaCacheSynchronizer.upsert(created, modelContext: modelContext)
            try? modelContext.save()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    public func updateIdea(
        ideaID: String,
        title: String,
        description: String,
        status: String,
        workspaceID: String
    ) async -> Bool {
        do {
            let updated = try await repository.updateIdea(
                ideaID: ideaID,
                input: IdeaUpdateInput(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                    status: status,
                    workspaceID: workspaceID
                )
            )
            merge(updated)
            IdeaCacheSynchronizer.upsert(updated, modelContext: modelContext)
            try? modelContext.save()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    public func setArchived(ideaID: String, archived: Bool) async -> Bool {
        do {
            let updated = try await repository.setArchived(ideaID: ideaID, archived: archived)
            merge(updated)
            IdeaCacheSynchronizer.upsert(updated, modelContext: modelContext)
            try? modelContext.save()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func idea(id: String) -> IdeaRecord? {
        (ideas + archivedIdeas).first(where: { $0.id == id })
    }

    public func activities(for ideaID: String) -> [IdeaActivityRecord] {
        activitiesByIdeaID[ideaID] ?? []
    }

    public func reloadActivities(ideaID: String) async {
        guard !isLoadingActivities else { return }
        isLoadingActivities = true
        defer { isLoadingActivities = false }

        do {
            let activities = try await repository.listIdeaActivities(ideaID: ideaID)
            activitiesByIdeaID[ideaID] = activities
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func createActivity(
        ideaID: String,
        activityType: String,
        content: String,
        metadata: [String: String] = [:],
        attachmentURLs: [URL] = []
    ) async -> Bool {
        do {
            let activity = try await repository.createIdeaActivity(
                ideaID: ideaID,
                input: IdeaActivityCreateInput(
                    activityType: activityType,
                    content: content.trimmingCharacters(in: .whitespacesAndNewlines),
                    metadata: metadata,
                    attachmentURLs: attachmentURLs
                )
            )
            var activities = activitiesByIdeaID[ideaID] ?? []
            activities.removeAll { $0.id == activity.id }
            activities.insert(activity, at: 0)
            activitiesByIdeaID[ideaID] = activities
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func moveIdeas(from source: IndexSet, to destination: Int) {
        let movedRecords = source.compactMap { index in
            ideas.indices.contains(index) ? ideas[index] : nil
        }
        var reordered = ideas
        reordered.move(fromOffsets: source, toOffset: destination)

        for index in reordered.indices {
            reordered[index].sortOrder = (index + 1) * 1_000
        }
        ideas = reordered
        IdeaCacheSynchronizer.upsert(reordered, modelContext: modelContext)
        try? modelContext.save()

        let orderedIDs = reordered.map(\.id)
        Task {
            do {
                try await repository.reorderIdeas(teamID: teamID, ideaIDs: orderedIDs)
                for record in movedRecords {
                    if let newIndex = orderedIDs.firstIndex(of: record.id) {
                        await createActivity(
                            ideaID: record.id,
                            activityType: "reorder",
                            content: "Moved to position \(newIndex + 1)",
                            metadata: [
                                "position": "\(newIndex + 1)",
                                "total": "\(orderedIDs.count)",
                            ]
                        )
                    }
                }
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
                await reload()
            }
        }
    }

    private func apply(_ records: [IdeaRecord]) {
        let sorted = sort(records)
        ideas = sorted.filter { !$0.archived }
        archivedIdeas = sorted.filter(\.archived)
    }

    private func merge(_ record: IdeaRecord) {
        let previous = idea(id: record.id)
        var all = Dictionary(uniqueKeysWithValues: (ideas + archivedIdeas).map { ($0.id, $0) })
        all[record.id] = record
        apply(Array(all.values))

        if let previous, previous.status != record.status {
            Task {
                await createActivity(
                    ideaID: record.id,
                    activityType: "status_change",
                    content: "Changed status from \(previous.statusLabel) to \(record.statusLabel)",
                    metadata: [
                        "from_status": previous.status,
                        "to_status": record.status,
                    ]
                )
            }
        }
    }

    private func sort(_ records: [IdeaRecord]) -> [IdeaRecord] {
        records.sorted { lhs, rhs in
            if lhs.sortOrder != rhs.sortOrder {
                return lhs.sortOrder < rhs.sortOrder
            }
            if lhs.updatedAt == rhs.updatedAt {
                return lhs.createdAt > rhs.createdAt
            }
            return lhs.updatedAt > rhs.updatedAt
        }
    }
}
