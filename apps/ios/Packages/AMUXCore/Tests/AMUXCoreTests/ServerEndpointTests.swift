import XCTest
@testable import AMUXCore

/// `ServerEndpoint.normalize` guards the pre-auth server sheet: whatever it
/// returns is persisted as the Cloud API base URL, so a value it lets
/// through wrongly can wedge the app at launch.
final class ServerEndpointTests: XCTestCase {
    func testNormalizeDefaultsSchemeToHTTPS() {
        XCTAssertEqual(
            ServerEndpoint.normalize("api.example.com")?.absoluteString,
            "https://api.example.com"
        )
    }

    func testNormalizeKeepsExplicitHTTPAndPort() {
        XCTAssertEqual(
            ServerEndpoint.normalize("http://192.168.1.10:8787")?.absoluteString,
            "http://192.168.1.10:8787"
        )
    }

    func testNormalizeTrimsWhitespaceAndTrailingSlashes() {
        XCTAssertEqual(
            ServerEndpoint.normalize("  https://api.example.com//  ")?.absoluteString,
            "https://api.example.com"
        )
    }

    func testNormalizeKeepsPathPrefix() {
        XCTAssertEqual(
            ServerEndpoint.normalize("https://example.com/teamclu/")?.absoluteString,
            "https://example.com/teamclu"
        )
    }

    func testNormalizeRejectsGarbage() {
        XCTAssertNil(ServerEndpoint.normalize(""))
        XCTAssertNil(ServerEndpoint.normalize("   "))
        XCTAssertNil(ServerEndpoint.normalize("ftp://example.com"))
        XCTAssertNil(ServerEndpoint.normalize("https://"))
    }

    func testOverrideRoundTrip() throws {
        let suite = "ServerEndpointTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(CloudAPIConfigurationStore.hasCloudAPIURLOverride(in: defaults))

        let url = try XCTUnwrap(ServerEndpoint.normalize("https://self.example.com"))
        CloudAPIConfigurationStore.setCloudAPIURLOverride(url, in: defaults)
        XCTAssertTrue(CloudAPIConfigurationStore.hasCloudAPIURLOverride(in: defaults))
        XCTAssertEqual(
            CloudAPIConfigurationStore.storedCloudAPIURL(in: defaults),
            "https://self.example.com"
        )

        CloudAPIConfigurationStore.setCloudAPIURLOverride(nil, in: defaults)
        XCTAssertFalse(CloudAPIConfigurationStore.hasCloudAPIURLOverride(in: defaults))
    }
}
