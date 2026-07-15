import Foundation
import SwiftData

@MainActor
public enum ShortcutCacheSynchronizer {
    public static func upsert(_ records: [ShortcutRecord], modelContext: ModelContext) {
        for r in records { upsert(r, modelContext: modelContext) }
        try? modelContext.save()
    }

    public static func upsert(_ record: ShortcutRecord, modelContext: ModelContext) {
        let id = record.id
        let descriptor = FetchDescriptor<CachedShortcut>(
            predicate: #Predicate { $0.shortcutId == id }
        )
        if let existing = try? modelContext.fetch(descriptor).first {
            existing.scope         = record.scope.rawValue
            existing.ownerMemberId = record.ownerMemberID
            existing.teamId        = record.teamID
            existing.parentId      = record.parentID
            existing.label         = record.label
            existing.icon          = record.icon
            existing.order         = record.order
            existing.nodeType      = record.type.rawValue
            existing.target        = record.target
            existing.createdAt     = record.createdAt
            existing.updatedAt     = record.updatedAt
        } else {
            modelContext.insert(CachedShortcut(
                shortcutId:    record.id,
                scope:         record.scope.rawValue,
                ownerMemberId: record.ownerMemberID,
                teamId:        record.teamID,
                parentId:      record.parentID,
                label:         record.label,
                icon:          record.icon,
                order:         record.order,
                nodeType:      record.type.rawValue,
                target:        record.target,
                createdAt:     record.createdAt,
                updatedAt:     record.updatedAt
            ))
        }
    }

    /// Deletes cached personal rows not present in `keeping`.
    public static func deleteMissingPersonal(
        keeping ids: Set<String>,
        modelContext: ModelContext
    ) {
        let personalRaw = ShortcutScope.personal.rawValue
        let descriptor = FetchDescriptor<CachedShortcut>(
            predicate: #Predicate { $0.scope == personalRaw }
        )
        guard let all = try? modelContext.fetch(descriptor) else { return }
        for row in all where !ids.contains(row.shortcutId) {
            modelContext.delete(row)
        }
        try? modelContext.save()
    }

    /// Deletes cached team rows for `teamID` not present in `keeping`.
    public static func deleteMissingTeam(
        keeping ids: Set<String>,
        teamID: String,
        modelContext: ModelContext
    ) {
        let teamRaw = ShortcutScope.team.rawValue
        let descriptor = FetchDescriptor<CachedShortcut>(
            predicate: #Predicate { $0.scope == teamRaw && $0.teamId == teamID }
        )
        guard let all = try? modelContext.fetch(descriptor) else { return }
        for row in all where !ids.contains(row.shortcutId) {
            modelContext.delete(row)
        }
        try? modelContext.save()
    }
}

extension CachedShortcut {
    public var asRecord: ShortcutRecord {
        ShortcutRecord(
            id: shortcutId,
            scope: ShortcutScope(rawValue: scope) ?? .personal,
            ownerMemberID: ownerMemberId,
            teamID: teamId,
            parentID: parentId,
            label: label,
            icon: icon,
            order: order,
            type: ShortcutNodeType(rawValue: nodeType) ?? .native,
            target: target,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}
