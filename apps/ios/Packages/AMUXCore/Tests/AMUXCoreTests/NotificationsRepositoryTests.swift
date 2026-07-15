import Foundation
import Testing
@testable import AMUXCore

@Suite("Cloud API notifications repository")
struct NotificationsRepositoryTests {
    @Test
    func getPrefsDecodesSnakeCaseRow() async throws {
        let recorder = NotificationsRequestRecorder()
        let client = makeClient { request in
            await recorder.append(request)
            return try response("""
            {
              "user_id": "user-1",
              "enabled": false,
              "dnd_start_min": 1320,
              "dnd_end_min": 420,
              "dnd_tz": "Asia/Shanghai",
              "updated_at": "2026-06-10T10:00:00Z"
            }
            """)
        }
        let repo = CloudAPINotificationsRepository(client: client)

        let prefs = try await repo.getPrefs()

        #expect(prefs == NotificationPrefsRecord(
            enabled: false, dndStartMin: 1320, dndEndMin: 420, dndTZ: "Asia/Shanghai"
        ))
        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/notifications/prefs")
        #expect(request.httpMethod == "GET")
    }

    @Test
    func getPrefsToleratesNullRow() async throws {
        let client = makeClient { _ in try response("null") }
        let repo = CloudAPINotificationsRepository(client: client)
        let prefs = try await repo.getPrefs()
        #expect(prefs == nil)
    }

    @Test
    func getPrefsToleratesEmptyBody() async throws {
        let client = makeClient { _ in
            let http = try #require(HTTPURLResponse(
                url: URL(string: "https://fc.example.com")!,
                statusCode: 200, httpVersion: nil, headerFields: nil
            ))
            return (Data(), http)
        }
        let repo = CloudAPINotificationsRepository(client: client)
        let prefs = try await repo.getPrefs()
        #expect(prefs == nil)
    }

    @Test
    func putPrefsEncodesSnakeCaseBodyAndDecodesEcho() async throws {
        let recorder = NotificationsRequestRecorder()
        let client = makeClient { request in
            await recorder.append(request)
            return try response("""
            {
              "user_id": "user-1",
              "enabled": true,
              "dnd_start_min": 1320,
              "dnd_end_min": 420,
              "dnd_tz": "Asia/Shanghai",
              "updated_at": "2026-06-10T10:00:00Z"
            }
            """)
        }
        let repo = CloudAPINotificationsRepository(client: client)

        let result = try await repo.putPrefs(NotificationPrefsRecord(
            enabled: true, dndStartMin: 1320, dndEndMin: 420, dndTZ: "Asia/Shanghai"
        ))

        #expect(result.enabled == true)
        #expect(result.dndStartMin == 1320)
        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/notifications/prefs")
        #expect(request.httpMethod == "PUT")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["enabled"] as? Bool == true)
        #expect(json["dnd_start_min"] as? Int == 1320)
        #expect(json["dnd_end_min"] as? Int == 420)
        #expect(json["dnd_tz"] as? String == "Asia/Shanghai")
    }

    @Test
    func listMutedSessionIDsDecodesItems() async throws {
        let recorder = NotificationsRequestRecorder()
        let client = makeClient { request in
            await recorder.append(request)
            return try response("""
            { "items": ["session-a", "session-b"] }
            """)
        }
        let repo = CloudAPINotificationsRepository(client: client)

        let muted = try await repo.listMutedSessionIDs()

        #expect(muted == Set(["session-a", "session-b"]))
        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/notifications/muted-sessions")
    }

    @Test
    func mutePostsToSessionMutePath() async throws {
        let recorder = NotificationsRequestRecorder()
        let client = makeClient { request in
            await recorder.append(request)
            return try noContent()
        }
        let repo = CloudAPINotificationsRepository(client: client)

        try await repo.mute(sessionID: "session-1", until: nil)

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/sessions/session-1/mute")
        #expect(request.httpMethod == "POST")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        // nil `until` is omitted entirely — FC reads that as a permanent mute.
        #expect(json["until"] == nil)
    }

    @Test
    func muteUntilEncodesISO8601Date() async throws {
        let recorder = NotificationsRequestRecorder()
        let client = makeClient { request in
            await recorder.append(request)
            return try noContent()
        }
        let repo = CloudAPINotificationsRepository(client: client)
        let until = ISO8601DateFormatter().date(from: "2026-06-12T08:00:00Z")!

        try await repo.mute(sessionID: "session-1", until: until)

        let request = try #require(await recorder.requests.first)
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let untilString = try #require(json["until"] as? String)
        #expect(ISO8601DateFormatter.withFractional.date(from: untilString) == until)
    }

    @Test
    func unmuteDeletesSessionMutePath() async throws {
        let recorder = NotificationsRequestRecorder()
        let client = makeClient { request in
            await recorder.append(request)
            return try noContent()
        }
        let repo = CloudAPINotificationsRepository(client: client)

        try await repo.unmute(sessionID: "session-1")

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/sessions/session-1/mute")
        #expect(request.httpMethod == "DELETE")
    }

    private func makeClient(send: @escaping CloudAPISend) -> CloudAPIClient {
        CloudAPIClient(
            configuration: CloudAPIConfiguration(
                baseURL: URL(string: "https://fc.example.com")!
            ),
            accessToken: { "access-token" },
            send: send
        )
    }
}

@Suite("NotificationPrefsStore")
@MainActor
struct NotificationPrefsStoreTests {
    @Test
    func reloadPopulatesPrefsAndMutedSet() async {
        let repo = MockNotificationsRepository()
        repo.prefsResult = NotificationPrefsRecord(
            enabled: false, dndStartMin: 60, dndEndMin: 120, dndTZ: "Asia/Shanghai"
        )
        repo.mutedResult = ["session-a"]
        let store = NotificationPrefsStore(repository: repo)

        await store.reload()

        #expect(store.prefs.enabled == false)
        #expect(store.prefs.dndStartMin == 60)
        #expect(store.mutedSessionIDs == ["session-a"])
        #expect(store.errorMessage == nil)
    }

    @Test
    func reloadFallsBackToDefaultsWhenNoRow() async {
        let repo = MockNotificationsRepository()
        repo.prefsResult = nil
        let store = NotificationPrefsStore(repository: repo)

        await store.reload()

        #expect(store.prefs == NotificationPrefsRecord())
        #expect(store.prefs.enabled == true)
    }

    @Test
    func toggleMuteOptimisticallyInsertsAndCallsMute() async {
        let repo = MockNotificationsRepository()
        let store = NotificationPrefsStore(repository: repo)

        await store.toggleMute(sessionID: "session-1")

        #expect(store.mutedSessionIDs.contains("session-1"))
        #expect(repo.muteCalls.map(\.0) == ["session-1"])
        #expect(repo.muteCalls.first?.1 == nil) // permanent mute
        #expect(repo.unmuteCalls.isEmpty)
    }

    @Test
    func toggleMuteOnMutedSessionCallsUnmute() async {
        let repo = MockNotificationsRepository()
        repo.mutedResult = ["session-1"]
        let store = NotificationPrefsStore(repository: repo)
        await store.reload()

        await store.toggleMute(sessionID: "session-1")

        #expect(!store.mutedSessionIDs.contains("session-1"))
        #expect(repo.unmuteCalls == ["session-1"])
        #expect(repo.muteCalls.isEmpty)
    }

    @Test
    func toggleMuteRollsBackOnFailure() async {
        let repo = MockNotificationsRepository()
        repo.muteError = TestStubError.boom
        let store = NotificationPrefsStore(repository: repo)

        await store.toggleMute(sessionID: "session-1")

        #expect(!store.mutedSessionIDs.contains("session-1"))
        #expect(store.errorMessage != nil)
    }

    @Test
    func unmuteRollsBackOnFailure() async {
        let repo = MockNotificationsRepository()
        repo.mutedResult = ["session-1"]
        repo.unmuteError = TestStubError.boom
        let store = NotificationPrefsStore(repository: repo)
        await store.reload()

        await store.toggleMute(sessionID: "session-1")

        #expect(store.mutedSessionIDs.contains("session-1"))
        #expect(store.errorMessage != nil)
    }

    @Test
    func setEnabledSettlesOnServerEcho() async {
        let repo = MockNotificationsRepository()
        repo.putEcho = { var p = $0; p.dndTZ = "Asia/Shanghai"; return p }
        let store = NotificationPrefsStore(repository: repo)

        await store.setEnabled(false)

        #expect(store.prefs.enabled == false)
        #expect(store.prefs.dndTZ == "Asia/Shanghai") // server-normalized row wins
        #expect(repo.putCalls.count == 1)
        #expect(repo.putCalls.first?.enabled == false)
    }

    @Test
    func setEnabledRollsBackOnFailure() async {
        let repo = MockNotificationsRepository()
        repo.putError = TestStubError.boom
        let store = NotificationPrefsStore(repository: repo)

        await store.setEnabled(false)

        #expect(store.prefs.enabled == true)
        #expect(store.errorMessage != nil)
    }

    @Test
    func setQuietHoursWritesCurrentTimeZone() async {
        let repo = MockNotificationsRepository()
        let store = NotificationPrefsStore(repository: repo)

        await store.setQuietHours(startMin: 22 * 60, endMin: 7 * 60)

        let written = repo.putCalls.first
        #expect(written?.dndStartMin == 22 * 60)
        #expect(written?.dndEndMin == 7 * 60)
        #expect(written?.dndTZ == TimeZone.current.identifier)
    }
}

// MARK: - Test plumbing

private enum TestStubError: Error { case boom }

/// Test-only mock. `@unchecked Sendable` is fine here: every access happens
/// serially from the MainActor-bound test + store.
private final class MockNotificationsRepository: NotificationsRepository, @unchecked Sendable {
    var prefsResult: NotificationPrefsRecord?
    var mutedResult: Set<String> = []
    var putEcho: (NotificationPrefsRecord) -> NotificationPrefsRecord = { $0 }
    var putError: Error?
    var muteError: Error?
    var unmuteError: Error?

    private(set) var putCalls: [NotificationPrefsRecord] = []
    private(set) var muteCalls: [(String, Date?)] = []
    private(set) var unmuteCalls: [String] = []

    func getPrefs() async throws -> NotificationPrefsRecord? { prefsResult }

    func putPrefs(_ prefs: NotificationPrefsRecord) async throws -> NotificationPrefsRecord {
        putCalls.append(prefs)
        if let putError { throw putError }
        return putEcho(prefs)
    }

    func listMutedSessionIDs() async throws -> Set<String> { mutedResult }

    func mute(sessionID: String, until: Date?) async throws {
        muteCalls.append((sessionID, until))
        if let muteError { throw muteError }
    }

    func unmute(sessionID: String) async throws {
        unmuteCalls.append(sessionID)
        if let unmuteError { throw unmuteError }
    }
}

private actor NotificationsRequestRecorder {
    private var stored: [URLRequest] = []

    var requests: [URLRequest] {
        stored
    }

    func append(_ request: URLRequest) {
        stored.append(request)
    }
}

private func response(_ json: String, status: Int = 200) throws -> (Data, HTTPURLResponse) {
    let url = URL(string: "https://fc.example.com")!
    let http = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
    return (Data(json.utf8), http)
}

private func noContent() throws -> (Data, HTTPURLResponse) {
    let url = URL(string: "https://fc.example.com")!
    let http = try #require(HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil))
    return (Data(), http)
}

private extension ISO8601DateFormatter {
    static var withFractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
