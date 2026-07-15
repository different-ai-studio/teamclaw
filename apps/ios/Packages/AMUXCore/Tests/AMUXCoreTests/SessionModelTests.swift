import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionModelTests: XCTestCase {
    func test_session_defaultSelectedAgentIdsIsEmpty() {
        let s = Session(sessionId: "s1")
        XCTAssertEqual(s.selectedAgentIds, [])
    }

    func test_session_persistsSelectedAgentIds_roundTrip() throws {
        let container = try ModelContainer(
            for: Session.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        let s = Session(sessionId: "s1")
        s.selectedAgentIds = ["a1", "a2"]
        ctx.insert(s)
        try ctx.save()

        let fetched = try ctx.fetch(FetchDescriptor<Session>())
        XCTAssertEqual(fetched.first?.selectedAgentIds, ["a1", "a2"])
    }
}
