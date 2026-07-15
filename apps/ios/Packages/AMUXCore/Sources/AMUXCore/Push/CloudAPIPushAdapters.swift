import Foundation

// Cloud API implementations of the push protocols. Identity is derived
// server-side from the bearer token, so these adapters never carry a user id.

// MARK: - Token uploader

public actor CloudAPIPushTokenUploader: PushTokenUploader {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func upload(userID: String, deviceID: String, platform: String,
                       provider: String, token: String, appVersion: String?) async throws {
        // userID is ignored — the FC route resolves it from the bearer token.
        try await client.postVoid("/v1/devices/push-token", body: TokenRequest(
            deviceId: deviceID, platform: platform, provider: provider,
            token: token, appVersion: appVersion
        ))
    }

    private struct TokenRequest: Encodable, Sendable {
        let deviceId: String
        let platform: String
        let provider: String
        let token: String
        let appVersion: String?
    }
}

// MARK: - Preferences

public actor CloudAPIPushPreferences: PushPreferencesAPI {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func load() async throws -> NotificationPrefs {
        // FC returns the raw snake_case row, or `null` when no prefs exist.
        let row: PrefsRow? = try await client.get("/v1/notifications/prefs")
        guard let r = row else { return NotificationPrefs() }
        return NotificationPrefs(
            enabled: r.enabled,
            dndStartMin: r.dnd_start_min,
            dndEndMin: r.dnd_end_min,
            dndTz: r.dnd_tz ?? TimeZone.current.identifier
        )
    }

    public func save(_ prefs: NotificationPrefs) async throws {
        try await client.putVoid("/v1/notifications/prefs", body: PrefsWrite(
            enabled: prefs.enabled,
            dnd_start_min: prefs.dndStartMin,
            dnd_end_min: prefs.dndEndMin,
            dnd_tz: prefs.dndTz
        ))
    }

    public func setSessionMuted(sessionID: String, muted: Bool) async throws {
        let encoded = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        if muted {
            try await client.postVoid("/v1/sessions/\(encoded)/mute", body: MuteRequest(until: nil))
        } else {
            try await client.deleteVoid("/v1/sessions/\(encoded)/mute")
        }
    }

    public func isSessionMuted(sessionID: String) async throws -> Bool {
        // No targeted endpoint — fetch the muted list and test membership.
        let list: MutedList = try await client.get("/v1/sessions/muted")
        return list.items.contains(sessionID)
    }

    private struct PrefsRow: Decodable, Sendable {
        let enabled: Bool
        let dnd_start_min: Int?
        let dnd_end_min: Int?
        let dnd_tz: String?
    }

    private struct PrefsWrite: Encodable, Sendable {
        let enabled: Bool
        let dnd_start_min: Int?
        let dnd_end_min: Int?
        let dnd_tz: String
    }

    private struct MuteRequest: Encodable, Sendable {
        let until: String?
    }

    private struct MutedList: Decodable, Sendable {
        let items: [String]
    }
}

// MARK: - Presence

public actor CloudAPIPresenceWriter: PresenceWriter {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func writeForeground(deviceID: String, until: Date) async throws {
        try await client.postVoid("/v1/presence/foreground", body: PresenceRequest(
            deviceId: deviceID,
            foregroundUntil: ISO8601DateFormatter().string(from: until)
        ))
    }

    private struct PresenceRequest: Encodable, Sendable {
        let deviceId: String
        let foregroundUntil: String
    }
}
