import XCTest

final class NavigationUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launch()
    }

    func testPairingViewShownOnFirstLaunch() {
        // On first launch with no pairing, should show pairing view
        // Check for the pairing icon or title text
        let exists = app.staticTexts["连接桌面端"].waitForExistence(timeout: 5)
            || app.staticTexts["Connect Desktop"].waitForExistence(timeout: 2)
        XCTAssertTrue(exists, "Pairing view should be shown on first launch")
    }
}
