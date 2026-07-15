import Foundation

public protocol ShortcutsRepository: Sendable {
    func listPersonal() async throws -> [ShortcutRecord]
    func listTeam(teamID: String) async throws -> [ShortcutRecord]
}
