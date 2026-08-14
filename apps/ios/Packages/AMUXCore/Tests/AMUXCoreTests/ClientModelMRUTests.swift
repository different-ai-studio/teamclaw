import XCTest
@testable import AMUXCore

/// Each test gets its own suite name so nothing leaks between them or into the
/// real defaults.
private func makeDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
    UserDefaults(suiteName: name)!
}

final class ClientModelMRUTests: XCTestCase {
    func testMovesAnExistingEntryToTheFront() {
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "team-1", model: "a/1")
        mru.record(backend: "opencode", teamID: "team-1", model: "b/2")
        mru.record(backend: "opencode", teamID: "team-1", model: "a/1")
        XCTAssertEqual(mru.recent(backend: "opencode", teamID: "team-1"), ["a/1", "b/2"])
    }

    func testKeepsBackendsApart() {
        // Model ids are backend-local: a pi id handed to opencode is not a
        // degraded answer, it is a wrong one.
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "t", model: "opencode/big-pickle")
        mru.record(backend: "pi", teamID: "t", model: "anthropic/claude-sonnet-4-6")

        XCTAssertEqual(mru.recent(backend: "opencode", teamID: "t"), ["opencode/big-pickle"])
        XCTAssertEqual(mru.recent(backend: "pi", teamID: "t"), ["anthropic/claude-sonnet-4-6"])
        XCTAssertEqual(mru.recent(backend: "cursor", teamID: "t"), [])
    }

    func testKeepsTeamsApart() {
        // Catalogs vary by team (the team's LiteLLM gateway models) — the only
        // variable #742 could attribute a catalog difference to.
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "team-1", model: "gw/one")
        mru.record(backend: "opencode", teamID: "team-2", model: "gw/two")

        XCTAssertEqual(mru.recent(backend: "opencode", teamID: "team-1"), ["gw/one"])
        XCTAssertEqual(mru.recent(backend: "opencode", teamID: "team-2"), ["gw/two"])
    }

    func testIgnoresBlankInputs() {
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "t", model: "   ")
        mru.record(backend: "", teamID: "t", model: "a/1")
        mru.record(backend: "opencode", teamID: "", model: "a/1")
        XCTAssertEqual(mru.recent(backend: "opencode", teamID: "t"), [])
    }

    func testCapsTheList() {
        let mru = ClientModelMRU(defaults: makeDefaults())
        for i in 0..<15 {
            mru.record(backend: "opencode", teamID: "t", model: "p/\(i)")
        }
        let recent = mru.recent(backend: "opencode", teamID: "t")
        XCTAssertEqual(recent.count, ClientModelMRU.maxRecent)
        XCTAssertEqual(recent.first, "p/14")
    }

    func testSurvivesAcrossInstances() {
        // The whole point of persisting: a relaunch must remember.
        let defaults = makeDefaults()
        ClientModelMRU(defaults: defaults).record(backend: "opencode", teamID: "t", model: "a/1")
        XCTAssertEqual(ClientModelMRU(defaults: defaults).recent(backend: "opencode", teamID: "t"), ["a/1"])
    }

    func testFirstAvailableSkipsRetiredEntries() {
        // The reason it is a list: "last used" was retired, so the next usable
        // entry wins rather than pinning something that cannot run.
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "t", model: "b/2")
        mru.record(backend: "opencode", teamID: "t", model: "gone/x")

        XCTAssertEqual(
            mru.firstAvailable(backend: "opencode", teamID: "t", available: ["a/1", "b/2"]),
            "b/2"
        )
    }

    func testFirstAvailableIsNilWhenNothingMatches() {
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "t", model: "gone/x")
        XCTAssertNil(mru.firstAvailable(backend: "opencode", teamID: "t", available: ["a/1"]))
    }

    func testFirstAvailableIsNilWhenCatalogHasNotArrived() {
        // Empty catalog means "unknown", not "nothing runnable". Pinning against
        // an unknown catalog is how the wrong model got stuck before.
        let mru = ClientModelMRU(defaults: makeDefaults())
        mru.record(backend: "opencode", teamID: "t", model: "a/1")
        XCTAssertNil(mru.firstAvailable(backend: "opencode", teamID: "t", available: []))
    }

    func testPromoteReturnsInputWhenAlreadyHead() {
        XCTAssertEqual(ClientModelMRU.promote(["a", "b"], "a"), ["a", "b"])
    }
}
