import Testing
@testable import AMUXUI

@Suite("Create idea sheet toolbar presentation")
struct CreateIdeaSheetToolbarPresentationTests {
    @Test("toolbar actions use icon-only system images")
    func toolbarActionsUseIconOnlySystemImages() {
        #expect(CreateIdeaSheetToolbarPresentation.cancelSystemImage == "xmark")
        #expect(CreateIdeaSheetToolbarPresentation.submitSystemImage == "checkmark")
        #expect(CreateIdeaSheetToolbarPresentation.cancelAccessibilityLabel == "Cancel")
        #expect(CreateIdeaSheetToolbarPresentation.submitAccessibilityLabel == "Post")
    }
}
