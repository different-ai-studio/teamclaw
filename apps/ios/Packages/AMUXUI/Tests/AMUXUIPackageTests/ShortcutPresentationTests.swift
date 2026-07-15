import Foundation
import Testing
import AMUXCore
@testable import AMUXUI

@Suite("Shortcut presentation")
struct ShortcutPresentationTests {
    @Test("link shortcuts open embedded web only for http URLs")
    func linkShortcutsOpenEmbeddedWebOnlyForHTTPURLs() {
        let secure = shortcut(id: "secure", type: .link, target: "https://teamclaw.app/docs")
        let plain = shortcut(id: "plain", type: .link, target: "http://localhost:3000")
        let customScheme = shortcut(id: "custom", type: .link, target: "teamclaw://join?token=x")
        let malformed = shortcut(id: "bad", type: .link, target: "not a url")

        #expect(ShortcutPresentation.destination(for: secure) == .web(URL(string: secure.target)!))
        #expect(ShortcutPresentation.destination(for: plain) == .web(URL(string: plain.target)!))
        #expect(ShortcutPresentation.destination(for: customScheme) == .disabled)
        #expect(ShortcutPresentation.destination(for: malformed) == .disabled)
    }

    @Test("folders navigate deeper and native shortcuts stay disabled")
    func foldersNavigateDeeperAndNativeShortcutsStayDisabled() {
        let folder = shortcut(id: "folder", type: .folder, target: "")
        let native = shortcut(id: "native", type: .native, target: "sessions")

        #expect(ShortcutPresentation.destination(for: folder) == .folder)
        #expect(ShortcutPresentation.destination(for: native) == .disabled)
    }
}

private func shortcut(
    id: String,
    type: ShortcutNodeType,
    target: String
) -> ShortcutRecord {
    ShortcutRecord(
        id: id,
        scope: .team,
        ownerMemberID: nil,
        teamID: "team-1",
        parentID: nil,
        label: id,
        icon: nil,
        order: 0,
        type: type,
        target: target,
        createdAt: Date(timeIntervalSince1970: 0),
        updatedAt: Date(timeIntervalSince1970: 0)
    )
}
