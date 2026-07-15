import Foundation

/// User-level notification preferences as the domain layer sees them.
/// Mirrors the FC `notification_prefs` row (identity comes from the bearer
/// token, so there is no user id here). `dndStartMin`/`dndEndMin` are
/// minute-of-day values (0–1439); both nil means quiet hours are off.
public struct NotificationPrefsRecord: Equatable, Sendable {
    public var enabled: Bool
    public var dndStartMin: Int?
    public var dndEndMin: Int?
    public var dndTZ: String?

    public init(
        enabled: Bool = true,
        dndStartMin: Int? = nil,
        dndEndMin: Int? = nil,
        dndTZ: String? = nil
    ) {
        self.enabled = enabled
        self.dndStartMin = dndStartMin
        self.dndEndMin = dndEndMin
        self.dndTZ = dndTZ
    }
}

/// Notification preferences + per-session mute list.
///
/// Backed by the Cloud API (`CloudAPINotificationsRepository`); the
/// observable façade for views is `NotificationPrefsStore`.
public protocol NotificationsRepository: Sendable {
    /// Returns nil when the user has no prefs row yet — callers fall back
    /// to defaults (`enabled == true`, no quiet hours).
    func getPrefs() async throws -> NotificationPrefsRecord?
    /// Upserts the prefs row and returns the server-normalized result.
    func putPrefs(_ prefs: NotificationPrefsRecord) async throws -> NotificationPrefsRecord
    /// Session ids the current user has muted.
    func listMutedSessionIDs() async throws -> Set<String>
    /// Mute a session; `until == nil` mutes permanently.
    func mute(sessionID: String, until: Date?) async throws
    func unmute(sessionID: String) async throws
}
