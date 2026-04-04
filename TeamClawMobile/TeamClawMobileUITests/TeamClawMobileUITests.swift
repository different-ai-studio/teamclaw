import XCTest

/// Tests that verify app launch performance and basic stability.
final class TeamClawMobileUITests: XCTestCase {

    func testAppLaunchesSuccessfully() throws {
        let app = XCUIApplication()
        app.launch()

        // App should show either pairing view or session list
        let pairingTitle = app.staticTexts["连接桌面端"]
        let sessionTitle = app.staticTexts["Session"]

        let launched = pairingTitle.waitForExistence(timeout: 5)
            || sessionTitle.waitForExistence(timeout: 2)
        XCTAssertTrue(launched, "App should show pairing or session view after launch")
    }

    func testLaunchPerformance() throws {
        if #available(iOS 17.0, *) {
            measure(metrics: [XCTApplicationLaunchMetric()]) {
                XCUIApplication().launch()
            }
        }
    }
}
