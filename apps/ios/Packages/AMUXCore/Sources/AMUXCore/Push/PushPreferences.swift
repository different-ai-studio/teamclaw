import Foundation

public struct NotificationPrefs: Equatable, Sendable {
    public var enabled: Bool
    public var dndStartMin: Int?
    public var dndEndMin: Int?
    public var dndTz: String

    public init(enabled: Bool = true,
                dndStartMin: Int? = nil,
                dndEndMin: Int? = nil,
                dndTz: String = TimeZone.current.identifier) {
        self.enabled = enabled
        self.dndStartMin = dndStartMin
        self.dndEndMin = dndEndMin
        self.dndTz = dndTz
    }

    public func isInDndWindow(at date: Date = Date()) -> Bool {
        guard let a = dndStartMin, let b = dndEndMin else { return false }
        if a == b { return false }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: dndTz) ?? .current
        let comps = cal.dateComponents([.hour, .minute], from: date)
        let m = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
        return a < b ? (m >= a && m < b) : (m >= a || m < b)
    }
}

public protocol PushPreferencesAPI: Sendable {
    func load() async throws -> NotificationPrefs
    func save(_ prefs: NotificationPrefs) async throws
    func setSessionMuted(sessionID: String, muted: Bool) async throws
    func isSessionMuted(sessionID: String) async throws -> Bool
}
