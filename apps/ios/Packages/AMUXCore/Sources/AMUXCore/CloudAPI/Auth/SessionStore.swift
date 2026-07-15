import Foundation

/// Owns the access/refresh token lifecycle that the Supabase SDK previously
/// managed: Keychain persistence, proactive + reactive refresh, and the
/// `tokenRefreshes()` stream that MQTT depends on.
public actor SessionStore {
    private let baseURL: URL
    private let storage: SessionStorage
    private let http: AuthHTTP

    private var session: StoredSession?
    private var refreshTask: Task<Void, Never>?
    private var continuations: [UUID: AsyncStream<Void>.Continuation] = [:]

    /// Refresh this many seconds before the JWT `exp` to absorb clock skew.
    private let refreshLeadSeconds: TimeInterval = 60

    public init(baseURL: URL, storage: SessionStorage, send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend) {
        self.baseURL = baseURL
        self.storage = storage
        self.http = AuthHTTP(baseURL: baseURL, send: send)
    }

    public func start() {
        session = (try? storage.load()) ?? nil
        scheduleProactiveRefresh()
    }

    public func setSession(_ new: StoredSession) {
        session = new
        try? storage.save(new)
        scheduleProactiveRefresh()
    }

    public func currentSession() -> StoredSession? { session }

    public func clear() {
        session = nil
        try? storage.clear()
        refreshTask?.cancel()
        refreshTask = nil
    }

    public func accessToken() async throws -> String {
        guard let s = session else { throw AuthRequired.notAuthenticated }
        if s.expiresAt.timeIntervalSinceNow <= refreshLeadSeconds {
            return try await refreshLocked().accessToken
        }
        return s.accessToken
    }

    public func forceRefresh() async throws {
        _ = try await refreshLocked()
    }

    public nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let id = UUID()
            Task { await self.register(id: id, continuation: continuation) }
            continuation.onTermination = { _ in Task { await self.unregister(id: id) } }
        }
    }

    private func register(id: UUID, continuation: AsyncStream<Void>.Continuation) {
        continuations[id] = continuation
    }

    private func unregister(id: UUID) {
        continuations[id] = nil
    }

    private func emitRefresh() {
        for c in continuations.values { c.yield() }
    }

    private func refreshLocked() async throws -> StoredSession {
        guard let s = session else { throw AuthRequired.notAuthenticated }
        struct Req: Encodable { let refreshToken: String }
        struct Res: Decodable { let accessToken: String; let refreshToken: String; let expiresAt: Int }
        do {
            let res: Res = try await http.post("/v1/auth/refresh", body: Req(refreshToken: s.refreshToken))
            let updated = StoredSession(
                accessToken: res.accessToken, refreshToken: res.refreshToken,
                expiresAt: Date(timeIntervalSince1970: TimeInterval(res.expiresAt)),
                isAnonymous: s.isAnonymous, email: s.email
            )
            session = updated
            try? storage.save(updated)
            scheduleProactiveRefresh()
            emitRefresh()
            return updated
        } catch let apiError as CloudAPIError {
            if case let .requestFailed(status, _, _) = apiError, (400..<500).contains(status) {
                // Token is invalid/expired — clear session to force re-login.
                clear()
                throw AuthRequired.notAuthenticated
            }
            // Network or server error — keep the session alive so the next
            // launch can retry instead of forcing a full re-login.
            throw apiError
        } catch {
            // URLError, decoding failure, etc. — preserve the session.
            throw error
        }
    }

    private func scheduleProactiveRefresh() {
        refreshTask?.cancel()
        guard let s = session else { return }
        let delay = max(0, s.expiresAt.timeIntervalSinceNow - refreshLeadSeconds)
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            try? await self?.forceRefresh()
        }
    }
}
