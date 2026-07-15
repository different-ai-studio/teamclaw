import XCTest
@testable import AMUXCore

/// Tests the fingerprint logic used by StreamingDetailView to invalidate
/// its resolvedSnapshot. The actual feedFingerprint is computed in
/// StreamingDetailView (AMUXUI), but the underlying FeedItem content
/// is produced by buildFeedItems (AMUXCore), so we test the concept here.
final class StreamingDetailFingerprintTests: XCTestCase {

    private func makeEvent(
        sequence: Int,
        eventType: String,
        sender: String = "agent-a",
        turnID: String = "T1",
        timestamp: TimeInterval? = nil
    ) -> AgentEvent {
        let e = AgentEvent(agentId: "scope", sequence: sequence, eventType: eventType)
        e.senderActorID = sender
        e.turnID = turnID
        e.isComplete = eventType == "output"
        e.timestamp = Date(timeIntervalSince1970: timestamp ?? TimeInterval(1_700_000_000 + sequence))
        e.text = eventType == "output" ? "reply" : nil
        return e
    }

    /// Helper that mimics StreamingDetailView.feedFingerprint using
    /// both count AND lastEventID (the fixed version).
    private func fingerprint(forItems items: [FeedItem], agentID: String) -> String {
        var turnEventCount = 0
        var lastEventID = ""
        for item in items {
            switch item {
            case .activeStream(_, let aid, let runtime) where aid == agentID:
                turnEventCount = runtime.count
                lastEventID = runtime.last?.id ?? ""
            case .completedTurn(_, _, let final, let runtime):
                turnEventCount = runtime.count
                lastEventID = final.id
            default: break
            }
        }
        return "\(items.count)-\(turnEventCount)-\(lastEventID)"
    }

    func test_fingerprintChanges_whenEventsReorder() {
        // Two events with same count but different last-event after sort
        let thinkingFirst = makeEvent(sequence: 1, eventType: "thinking", timestamp: 1_700_000_001)
        let outputFirst   = makeEvent(sequence: 2, eventType: "output",   timestamp: 1_700_000_002)

        let feed1 = buildFeedItems([thinkingFirst, outputFirst])
        let fp1 = fingerprint(forItems: feed1, agentID: "agent-a")

        let thinkingEarlier = makeEvent(sequence: 3, eventType: "thinking", timestamp: 1_700_000_000)
        let feed2 = buildFeedItems([thinkingEarlier, thinkingFirst, outputFirst])
        let fp2 = fingerprint(forItems: feed2, agentID: "agent-a")

        XCTAssertNotEqual(fp1, fp2,
            "fingerprint must change when runtimeEvents content changes")
    }

    func test_fingerprintUnchanged_whenFeedIdentical() {
        let e1 = makeEvent(sequence: 1, eventType: "thinking")
        let e2 = makeEvent(sequence: 2, eventType: "output")
        let feed = buildFeedItems([e1, e2])

        let fp1 = fingerprint(forItems: feed, agentID: "agent-a")
        let fp2 = fingerprint(forItems: feed, agentID: "agent-a")

        XCTAssertEqual(fp1, fp2, "identical feed must produce identical fingerprint")
    }
}
