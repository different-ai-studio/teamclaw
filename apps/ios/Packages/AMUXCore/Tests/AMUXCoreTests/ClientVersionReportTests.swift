import XCTest
@testable import AMUXCore

final class ClientVersionReportTests: XCTestCase {
    func testEncodesClientTypeIos() throws {
        let body = ClientVersionReport(clientType: "ios", version: "1.1.5", deviceId: "d1", build: "14")
        let data = try JSONEncoder().encode(body)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["clientType"] as? String, "ios")
        XCTAssertEqual(json["version"] as? String, "1.1.5")
        XCTAssertEqual(json["deviceId"] as? String, "d1")
        XCTAssertEqual(json["build"] as? String, "14")
    }
}
