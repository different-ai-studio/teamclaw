import XCTest
@testable import AMUXCore

final class OutboxSenderConflictTests: XCTestCase {

    func test_isConflict_trueFor409() {
        let err = CloudAPIError.requestFailed(status: 409, code: "conflict", message: "Conflict")
        XCTAssertTrue(OutboxSender.isConflictError(err),
            "CloudAPIError with status 409 must be classified as a conflict")
    }

    func test_isConflict_falseFor500() {
        let err = CloudAPIError.requestFailed(status: 500, code: "internal", message: "Server Error")
        XCTAssertFalse(OutboxSender.isConflictError(err))
    }

    func test_isConflict_falseForNetworkError() {
        let err = URLError(.notConnectedToInternet)
        XCTAssertFalse(OutboxSender.isConflictError(err))
    }
}
