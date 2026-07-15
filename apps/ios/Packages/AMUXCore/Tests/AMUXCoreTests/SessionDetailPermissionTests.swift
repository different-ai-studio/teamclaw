import XCTest
@testable import AMUXCore

@MainActor
final class SessionDetailPermissionTests: XCTestCase {

    func test_grantPermission_deduplicatesInFlightRequests() async {
        let vm = SessionDetailViewModel.testInstance()

        vm._test_markPermissionInFlight("req-001")
        XCTAssertTrue(vm._test_isPermissionInFlight("req-001"))

        vm._test_removePermissionInFlight("req-001")
        XCTAssertFalse(vm._test_isPermissionInFlight("req-001"))
    }

    func test_grantPermission_doesNotDuplicateForSameRequestId() async {
        let vm = SessionDetailViewModel.testInstance()
        var callCount = 0

        let first = vm._test_tryMarkInFlight("req-002")
        if first { callCount += 1 }
        let second = vm._test_tryMarkInFlight("req-002")
        XCTAssertFalse(second, "second tryMarkInFlight for same requestId must return false")
        XCTAssertEqual(callCount, 1)
    }
}
