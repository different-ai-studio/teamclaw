import Foundation
import SwiftData
import Testing
@testable import AMUXCore

@Suite("ShortcutsStore")
struct ShortcutsStoreTests {

    @MainActor
    @Test("reload populates personal + team and writes through cache")
    func reloadPopulatesAndCaches() async throws {
        let container = try makeInMemoryContainer()
        let context = ModelContext(container)
        let repo = InMemoryShortcutsRepository(
            personal: [
                makeShortcut(id: "p1", scope: .personal, ownerMemberID: "m1", label: "Inbox", order: 0)
            ],
            team: [
                "team-1": [
                    makeShortcut(id: "t1", scope: .team, teamID: "team-1", label: "Docs", order: 0),
                    makeShortcut(id: "t2", scope: .team, teamID: "team-1", label: "Wiki", order: 1),
                ]
            ]
        )
        let store = ShortcutsStore(teamID: "team-1", repository: repo, modelContext: context)

        await store.reload()

        #expect(store.personal.map(\.id) == ["p1"])
        #expect(store.team.map(\.id) == ["t1", "t2"])

        let cached = try context.fetch(FetchDescriptor<CachedShortcut>(
            sortBy: [SortDescriptor(\.shortcutId)]
        ))
        #expect(cached.map(\.shortcutId) == ["p1", "t1", "t2"])
    }

    @MainActor
    @Test("hydrateFromCache loads previously-cached rows synchronously")
    func hydrateFromCache() async throws {
        let container = try makeInMemoryContainer()
        let context = ModelContext(container)

        context.insert(CachedShortcut(
            shortcutId: "p1", scope: "personal",
            ownerMemberId: "m1", teamId: nil, parentId: nil,
            label: "Inbox", icon: nil, order: 0,
            nodeType: "native", target: "",
            createdAt: .distantPast, updatedAt: .distantPast
        ))
        context.insert(CachedShortcut(
            shortcutId: "t1", scope: "team",
            ownerMemberId: nil, teamId: "team-1", parentId: nil,
            label: "Docs", icon: nil, order: 0,
            nodeType: "link", target: "https://x.example",
            createdAt: .distantPast, updatedAt: .distantPast
        ))
        try context.save()

        let repo = InMemoryShortcutsRepository(personal: [], team: [:])
        let store = ShortcutsStore(teamID: "team-1", repository: repo, modelContext: context)

        store.hydrateFromCache()

        #expect(store.personal.map(\.id) == ["p1"])
        #expect(store.team.map(\.id) == ["t1"])
    }

    @MainActor
    @Test("children sorts by order within parent + scope")
    func childrenSortedByOrder() async throws {
        let container = try makeInMemoryContainer()
        let context = ModelContext(container)
        let repo = InMemoryShortcutsRepository(
            personal: [],
            team: [
                "team-1": [
                    makeShortcut(id: "root", scope: .team, teamID: "team-1", label: "Root", order: 0, type: .folder),
                    makeShortcut(id: "child-b", scope: .team, teamID: "team-1", parentID: "root", label: "B", order: 1),
                    makeShortcut(id: "child-a", scope: .team, teamID: "team-1", parentID: "root", label: "A", order: 0),
                ]
            ]
        )
        let store = ShortcutsStore(teamID: "team-1", repository: repo, modelContext: context)

        await store.reload()

        let kids = store.children(parentID: "root", scope: .team)
        #expect(kids.map(\.id) == ["child-a", "child-b"])

        let roots = store.children(parentID: nil, scope: .team)
        #expect(roots.map(\.id) == ["root"])
    }

    @MainActor
    @Test("reload prunes locally-cached rows no longer present remotely")
    func reloadPrunesStale() async throws {
        let container = try makeInMemoryContainer()
        let context = ModelContext(container)

        context.insert(CachedShortcut(
            shortcutId: "old", scope: "team",
            ownerMemberId: nil, teamId: "team-1", parentId: nil,
            label: "Old", icon: nil, order: 0,
            nodeType: "link", target: "x",
            createdAt: .distantPast, updatedAt: .distantPast
        ))
        try context.save()

        let repo = InMemoryShortcutsRepository(
            personal: [],
            team: ["team-1": [
                makeShortcut(id: "new", scope: .team, teamID: "team-1", label: "New", order: 0)
            ]]
        )
        let store = ShortcutsStore(teamID: "team-1", repository: repo, modelContext: context)

        await store.reload()

        let cached = try context.fetch(FetchDescriptor<CachedShortcut>())
        #expect(cached.map(\.shortcutId) == ["new"])
    }
}

private actor InMemoryShortcutsRepository: ShortcutsRepository {
    private var personalRows: [ShortcutRecord]
    private var teamRowsByID: [String: [ShortcutRecord]]

    init(personal: [ShortcutRecord], team: [String: [ShortcutRecord]]) {
        self.personalRows = personal
        self.teamRowsByID = team
    }

    func listPersonal() async throws -> [ShortcutRecord] {
        personalRows.sorted { $0.order < $1.order }
    }

    func listTeam(teamID: String) async throws -> [ShortcutRecord] {
        (teamRowsByID[teamID] ?? []).sorted { $0.order < $1.order }
    }
}

private func makeShortcut(
    id: String,
    scope: ShortcutScope,
    ownerMemberID: String? = nil,
    teamID: String? = nil,
    parentID: String? = nil,
    label: String,
    icon: String? = nil,
    order: Int,
    type: ShortcutNodeType = .link,
    target: String = "https://example.test"
) -> ShortcutRecord {
    ShortcutRecord(
        id: id,
        scope: scope,
        ownerMemberID: ownerMemberID,
        teamID: teamID,
        parentID: parentID,
        label: label,
        icon: icon,
        order: order,
        type: type,
        target: target,
        createdAt: .distantPast,
        updatedAt: .distantPast
    )
}

@MainActor
private func makeInMemoryContainer() throws -> ModelContainer {
    let schema = Schema(versionedSchema: AMUXSchemaV1.self)
    let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
    return try ModelContainer(for: schema, configurations: configuration)
}
