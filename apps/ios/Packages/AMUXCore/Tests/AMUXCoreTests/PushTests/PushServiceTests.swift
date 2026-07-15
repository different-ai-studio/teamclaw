import XCTest
@testable import AMUXCore

@MainActor
final class PushServiceTests: XCTestCase {
    final class MockUploader: PushTokenUploader, @unchecked Sendable {
        var calls: [(userID: String, deviceID: String, token: String)] = []
        func upload(userID: String, deviceID: String, platform: String,
                    provider: String, token: String, appVersion: String?) async throws {
            calls.append((userID, deviceID, token))
        }
    }

    func testUploadCallsUploaderOnce() async throws {
        let uploader = MockUploader()
        let svc = PushService(uploader: uploader,
                              userIDProvider: { "USER" },
                              deviceIDProvider: { "DEVICE" },
                              appVersionProvider: { "1.0.0" })
        try await svc.uploadToken("HEXTOKEN")
        XCTAssertEqual(uploader.calls.count, 1)
        XCTAssertEqual(uploader.calls[0].token, "HEXTOKEN")
        XCTAssertEqual(uploader.calls[0].deviceID, "DEVICE")
        XCTAssertEqual(uploader.calls[0].userID, "USER")
    }
}
