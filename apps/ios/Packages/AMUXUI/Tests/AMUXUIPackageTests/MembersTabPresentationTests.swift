import Testing
@testable import AMUXUI

@Suite("Members tab presentation")
struct MembersTabPresentationTests {
    @Test("tab bar is visible only at the members stack root")
    func tabBarVisibleOnlyAtRoot() {
        #expect(MembersTabPresentation.isTabBarVisible(navigationPath: []) == true)
        #expect(MembersTabPresentation.isTabBarVisible(navigationPath: ["actor:agent-1"]) == false)
    }
}
