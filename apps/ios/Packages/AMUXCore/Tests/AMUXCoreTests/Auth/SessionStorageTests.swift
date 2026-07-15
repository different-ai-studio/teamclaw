import XCTest
@testable import AMUXCore

final class SessionStorageTests: XCTestCase {
    func testInMemoryRoundTrip() throws {
        let storage = InMemorySessionStorage()
        let session = StoredSession(
            accessToken: "at", refreshToken: "rt",
            expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
            isAnonymous: false, email: "a@b.com"
        )
        try storage.save(session)
        let loaded = try storage.load()
        XCTAssertEqual(loaded, session)
        try storage.clear()
        XCTAssertNil(try storage.load())
    }
}
