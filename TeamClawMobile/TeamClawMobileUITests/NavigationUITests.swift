import XCTest

final class NavigationUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        // Clear pairing state for clean tests
        app.launchArguments = ["-teamclaw_is_paired", "NO"]
        app.launch()
    }

    // MARK: - Pairing Screen

    func testPairingViewShownOnFirstLaunch() {
        let title = app.staticTexts["连接桌面端"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "Pairing title should appear")
    }

    func testPairingViewHasCodeInput() {
        let textField = app.textFields["000000"]
        XCTAssertTrue(textField.waitForExistence(timeout: 5), "Code input should exist")
    }

    func testPairButtonDisabledWithEmptyCode() {
        let pairButton = app.buttons["配对"]
        XCTAssertTrue(pairButton.waitForExistence(timeout: 5))
        XCTAssertFalse(pairButton.isEnabled, "Pair button should be disabled with empty code")
    }

    func testPairButtonDisabledWithPartialCode() {
        let textField = app.textFields["000000"]
        XCTAssertTrue(textField.waitForExistence(timeout: 5))

        textField.tap()
        textField.typeText("123")

        let pairButton = app.buttons["配对"]
        XCTAssertFalse(pairButton.isEnabled, "Pair button should be disabled with < 6 digits")
    }

    func testPairButtonEnabledWithFullCode() {
        let textField = app.textFields["000000"]
        XCTAssertTrue(textField.waitForExistence(timeout: 5))

        textField.tap()
        textField.typeText("123456")

        let pairButton = app.buttons["配对"]
        XCTAssertTrue(pairButton.isEnabled, "Pair button should be enabled with 6 digits")
    }

    func testCodeInputLimitedTo6Digits() {
        let textField = app.textFields["000000"]
        XCTAssertTrue(textField.waitForExistence(timeout: 5))

        textField.tap()
        textField.typeText("12345678")

        let value = textField.value as? String ?? ""
        XCTAssertTrue(value.count <= 6, "Code should be limited to 6 digits, got: \(value)")
    }

    func testPairingInstructionTextExists() {
        let instruction = app.staticTexts["在桌面端设置中生成配对码，然后在下方输入"]
        XCTAssertTrue(instruction.waitForExistence(timeout: 5), "Instruction text should appear")
    }
}
