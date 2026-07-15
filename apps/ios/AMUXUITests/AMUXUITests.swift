import XCTest

final class AMUXUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testNewSessionNavigatesToFreshAgentDetail() throws {
        let app = XCUIApplication()
        app.launch()
        sleep(8)

        let sessionsTab = app.tabBars.buttons["Sessions"]
        if sessionsTab.waitForExistence(timeout: 5) {
            sessionsTab.tap()
        }

        let newSessionButton = app.buttons["sessions.newSessionButton"]
        XCTAssertTrue(newSessionButton.waitForExistence(timeout: 10), "New Session button did not appear")
        newSessionButton.tap()

        let messageField = app.textFields["newSession.messageField"]
        XCTAssertTrue(messageField.waitForExistence(timeout: 10), "New Session message field did not appear")

        let prompt = "UITest \(UUID().uuidString.prefix(8))"
        messageField.tap()
        messageField.typeText(prompt)

        let sendButton = app.buttons["newSession.sendButton"]
        XCTAssertTrue(sendButton.isEnabled, "Send button should be enabled after typing a prompt")
        sendButton.tap()

        let title = app.staticTexts[prompt]
        guard title.waitForExistence(timeout: 25) else {
            let screenshot = XCUIScreen.main.screenshot()
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = "new-session-agent-failure"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("Expected Agent detail title for prompt \(prompt) to appear.\nHierarchy:\n\(app.debugDescription)")
            return
        }
    }
}
