import XCTest
@testable import AMUXCore

@MainActor
final class NavigationRouterTests: XCTestCase {
    func testStartsWithNoPendingSession() {
        let router = NavigationRouter()
        XCTAssertNil(router.pendingSessionID)
    }

    func testOpenSessionRecordsIntent() {
        let router = NavigationRouter()
        router.openSession("sess-123")
        XCTAssertEqual(router.pendingSessionID, "sess-123")
    }

    func testOpenSessionTrimsWhitespace() {
        let router = NavigationRouter()
        router.openSession("  sess-123\n")
        XCTAssertEqual(router.pendingSessionID, "sess-123")
    }

    func testOpenSessionIgnoresEmptyOrBlank() {
        let router = NavigationRouter()
        router.openSession("")
        XCTAssertNil(router.pendingSessionID)
        router.openSession("   ")
        XCTAssertNil(router.pendingSessionID)
    }

    func testConsumerCanClearAndReopenSameSession() {
        let router = NavigationRouter()
        router.openSession("sess-1")
        XCTAssertEqual(router.pendingSessionID, "sess-1")
        // Consumer clears after navigating.
        router.pendingSessionID = nil
        // A repeat deep link to the same session re-records the intent,
        // producing a fresh nil -> id transition for observers.
        router.openSession("sess-1")
        XCTAssertEqual(router.pendingSessionID, "sess-1")
    }
}
