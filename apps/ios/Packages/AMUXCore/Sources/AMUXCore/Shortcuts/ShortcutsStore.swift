import Foundation
import Observation
import SwiftData

@Observable
@MainActor
public final class ShortcutsStore {
    public private(set) var personal: [ShortcutRecord] = []
    public private(set) var team: [ShortcutRecord] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any ShortcutsRepository
    private let modelContext: ModelContext

    public init(
        teamID: String,
        repository: any ShortcutsRepository,
        modelContext: ModelContext
    ) {
        self.teamID = teamID
        self.repository = repository
        self.modelContext = modelContext
    }

    public func hydrateFromCache() {
        let personalRaw = ShortcutScope.personal.rawValue
        let teamRaw     = ShortcutScope.team.rawValue
        let captured    = teamID

        let personalDescriptor = FetchDescriptor<CachedShortcut>(
            predicate: #Predicate { $0.scope == personalRaw },
            sortBy: [SortDescriptor(\.order)]
        )
        let teamDescriptor = FetchDescriptor<CachedShortcut>(
            predicate: #Predicate { $0.scope == teamRaw && $0.teamId == captured },
            sortBy: [SortDescriptor(\.order)]
        )

        if let rows = try? modelContext.fetch(personalDescriptor) {
            personal = rows.map(\.asRecord)
        }
        if let rows = try? modelContext.fetch(teamDescriptor) {
            team = rows.map(\.asRecord)
        }
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            async let personalTask = repository.listPersonal()
            async let teamTask     = repository.listTeam(teamID: teamID)
            let (remotePersonal, remoteTeam) = try await (personalTask, teamTask)

            ShortcutCacheSynchronizer.upsert(remotePersonal, modelContext: modelContext)
            ShortcutCacheSynchronizer.upsert(remoteTeam,     modelContext: modelContext)
            ShortcutCacheSynchronizer.deleteMissingPersonal(
                keeping: Set(remotePersonal.map(\.id)),
                modelContext: modelContext
            )
            ShortcutCacheSynchronizer.deleteMissingTeam(
                keeping: Set(remoteTeam.map(\.id)),
                teamID: teamID,
                modelContext: modelContext
            )

            personal = remotePersonal.sorted { $0.order < $1.order }
            team     = remoteTeam.sorted     { $0.order < $1.order }
            errorMessage = nil
        } catch is CancellationError {
            // SwiftUI .task cancelled (e.g. drawer dismissed mid-load).
            // Not a real failure — keep the last good state silent.
        } catch let urlError as URLError where urlError.code == .cancelled {
            // Same story for URLSession-level cancellation.
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func children(parentID: String?, scope: ShortcutScope) -> [ShortcutRecord] {
        let pool: [ShortcutRecord] = (scope == .personal) ? personal : team
        return pool
            .filter { $0.parentID == parentID }
            .sorted { $0.order < $1.order }
    }
}
