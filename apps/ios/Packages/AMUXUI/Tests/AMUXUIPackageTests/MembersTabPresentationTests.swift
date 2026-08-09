import SwiftUI
import Testing
@testable import AMUXUI

@Suite("Members tab presentation")
struct MembersTabPresentationTests {
    @Test("tab bar is visible only at the members stack root")
    func tabBarVisibleOnlyAtRoot() {
        #expect(MembersTabPresentation.isTabBarVisible(navigationPath: NavigationPath()) == true)
        var pushed = NavigationPath()
        pushed.append("actor:agent-1")
        #expect(MembersTabPresentation.isTabBarVisible(navigationPath: pushed) == false)
    }
}
