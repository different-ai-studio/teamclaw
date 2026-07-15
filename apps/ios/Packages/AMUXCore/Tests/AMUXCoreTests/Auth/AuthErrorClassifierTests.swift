import XCTest
@testable import AMUXCore

final class AuthErrorClassifierTests: XCTestCase {

    // MARK: - isIdentifierAlreadyInUse

    func testEmailExistsCodeDetected() {
        let err = CloudAPIError.requestFailed(status: 422, code: "email_exists", message: "x")
        XCTAssertTrue(AuthErrorClassifier.isIdentifierAlreadyInUse(err))
    }

    func testPhoneExistsCodeDetected() {
        let err = CloudAPIError.requestFailed(status: 422, code: "phone_exists", message: "x")
        XCTAssertTrue(AuthErrorClassifier.isIdentifierAlreadyInUse(err))
    }

    func testMessageFallbackDetectedWhenCodeIsGeneric() {
        // GoTrue build without error_code: FC's collapsed "validation_failed" +
        // the human message (note the "auth.updateUser:" prefix) must still hit.
        let err = CloudAPIError.requestFailed(
            status: 422, code: "validation_failed",
            message: "auth.updateUser: Email address already registered by another user")
        XCTAssertTrue(AuthErrorClassifier.isIdentifierAlreadyInUse(err))
    }

    func testChineseMessageFallbackDetected() {
        let err = CloudAPIError.requestFailed(status: 422, code: "validation_failed",
                                              message: "该邮箱已注册")
        XCTAssertTrue(AuthErrorClassifier.isIdentifierAlreadyInUse(err))
    }

    func testOther422NotMisclassified() {
        let err = CloudAPIError.requestFailed(status: 422, code: "validation_failed",
                                              message: "Password should be at least 6 characters")
        XCTAssertFalse(AuthErrorClassifier.isIdentifierAlreadyInUse(err))
    }

    func testNon422NotClassified() {
        let err = CloudAPIError.requestFailed(status: 500, code: "email_exists", message: "x")
        XCTAssertFalse(AuthErrorClassifier.isIdentifierAlreadyInUse(err))
    }

    func testNonCloudAPIErrorNotClassified() {
        struct Other: Error {}
        XCTAssertFalse(AuthErrorClassifier.isIdentifierAlreadyInUse(Other()))
    }

    // MARK: - invite claim classification

    func testAlreadyTeamMemberDetected() {
        let err = CloudAPIError.requestFailed(status: 409, code: nil,
                                              message: "already a member of this team")
        XCTAssertTrue(AuthErrorClassifier.isAlreadyTeamMember(err))
        XCTAssertFalse(AuthErrorClassifier.isInviteConsumed(err))
    }

    func testInviteConsumedDetected() {
        let err = CloudAPIError.requestFailed(status: 410, code: nil,
                                              message: "invite already consumed")
        XCTAssertTrue(AuthErrorClassifier.isInviteConsumed(err))
        XCTAssertFalse(AuthErrorClassifier.isAlreadyTeamMember(err))
    }
}
