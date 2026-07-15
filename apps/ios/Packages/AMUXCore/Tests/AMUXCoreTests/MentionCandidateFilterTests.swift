import XCTest
@testable import AMUXCore

final class MentionCandidateFilterTests: XCTestCase {
    private let human  = MentionTarget.testFixture(actorID: "h1", kind: .member, displayName: "Alice")
    private let agentA = MentionTarget.testFixture(actorID: "a1", kind: .agent,  displayName: "miniA")
    private let agentB = MentionTarget.testFixture(actorID: "a2", kind: .agent,  displayName: "miniB")

    func test_filter_excludesSelectedAgents() {
        let result = MentionCandidateFilter.filter(
            all: [human, agentA, agentB],
            query: "",
            selectedAgentIDs: ["a1"]
        )
        XCTAssertEqual(result.map(\.id), ["h1", "a2"])
    }

    func test_filter_humansAlwaysVisible_evenIfTheirIdIsInSelectedSet() {
        // Humans are always eligible — the selectedAgentIDs set only gates agents.
        let result = MentionCandidateFilter.filter(
            all: [human, agentA],
            query: "",
            selectedAgentIDs: ["h1", "a1"]
        )
        XCTAssertEqual(result.map(\.id), ["h1"])
    }

    func test_filter_querySubstring_caseInsensitive() {
        let result = MentionCandidateFilter.filter(
            all: [human, agentA, agentB],
            query: "MINI",
            selectedAgentIDs: []
        )
        XCTAssertEqual(result.map(\.id), ["a1", "a2"])
    }

    func test_filter_emptyQuery_returnsAll_whenNoneSelected() {
        let result = MentionCandidateFilter.filter(
            all: [human, agentA, agentB],
            query: "",
            selectedAgentIDs: []
        )
        XCTAssertEqual(result.map(\.id), ["h1", "a1", "a2"])
    }

    func test_filter_allAgentsSelected_onlyHumanRemains() {
        let result = MentionCandidateFilter.filter(
            all: [human, agentA, agentB],
            query: "",
            selectedAgentIDs: ["a1", "a2"]
        )
        XCTAssertEqual(result.map(\.id), ["h1"])
    }
}
