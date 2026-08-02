import Testing
@testable import AMUXUI

@Suite("Streaming detail presentation")
struct StreamingDetailPresentationTests {
    @Test("active route follows the agent live stream")
    func activeRouteFollowsLiveStream() {
        let route = TurnRoute(agentID: "agent-1")

        #expect(StreamingDetailPresentation.followsLiveStream(for: route))
    }

    @Test("completed route ignores agent live state")
    func completedRouteIgnoresLiveState() {
        let route = TurnRoute(agentID: "agent-1", frozenTurnID: "turn-finished")

        #expect(!StreamingDetailPresentation.followsLiveStream(for: route))
    }
}
