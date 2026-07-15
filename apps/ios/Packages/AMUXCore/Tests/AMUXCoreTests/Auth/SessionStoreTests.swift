import XCTest
@testable import AMUXCore

final class SessionStoreTests: XCTestCase {
    private func refreshResponder(at expiresAtEpoch: Int, count: LockedBox<Int>) -> CloudAPISend {
        { req in
            let n = (count.get() ?? 0) + 1; count.set(n)
            let json = #"{"accessToken":"at\#(n)","refreshToken":"rt\#(n)","expiresAt":\#(expiresAtEpoch)}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (json.data(using: .utf8)!, resp)
        }
    }

    func testAccessTokenReturnsCachedWhenValid() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "valid", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(3600), isAnonymous: false, email: nil))
        let count = LockedBox<Int>(); count.set(0)
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage,
            send: refreshResponder(at: 9_000_000_000, count: count))
        await store.start()
        let token = try await store.accessToken()
        XCTAssertEqual(token, "valid")
        XCTAssertEqual(count.get(), 0)
    }

    func testForceRefreshRotatesTokenAndEmits() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "old", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(3600), isAnonymous: false, email: nil))
        let count = LockedBox<Int>(); count.set(0)
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage,
            send: refreshResponder(at: 9_000_000_000, count: count))
        await store.start()

        let emitted = expectation(description: "tokenRefreshes emits")
        let stream = store.tokenRefreshes()
        Task { for await _ in stream { emitted.fulfill(); break } }

        try await store.forceRefresh()
        let token = try await store.accessToken()
        XCTAssertEqual(token, "at1")
        await fulfillment(of: [emitted], timeout: 2)
        XCTAssertEqual(try storage.load()?.refreshToken, "rt1")
    }

    func testAccessTokenWithNoSessionThrowsNotAuthenticated() async {
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: InMemorySessionStorage(),
            send: { _ in (Data(), HTTPURLResponse(url: URL(string: "https://c")!, statusCode: 200, httpVersion: nil, headerFields: nil)!) })
        await store.start()
        do { _ = try await store.accessToken(); XCTFail("expected throw") }
        catch AuthRequired.notAuthenticated {}
        catch { XCTFail("wrong error: \(error)") }
    }
}
