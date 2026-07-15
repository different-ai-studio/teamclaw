import XCTest
@testable import AMUXCore

@MainActor
final class SessionDetailViewModelRelabelTests: XCTestCase {

    // Helper: build a MemberSheetAgent with just the fields the relabel
    // pass reads (id + runtimeID).
    private func makeAgent(actorID: String, runtimeID: String?) -> MemberSheetAgent {
        MemberSheetAgent(
            id: actorID,
            displayName: actorID,
            workspacePath: "",
            agentType: "Claude",
            runtimeState: .ready,
            availableModels: [],
            currentModel: nil,
            runtimeID: runtimeID,
            workspaceID: nil,
            backendType: "claude"
        )
    }

    func test_relabel_rewritesRawRuntimeIDStampsToActorID() {
        let vm = SessionDetailViewModel.testInstance()
        let rawRID = "5ffcd7fc"
        let actorID = "c6205a14-0af5-47c9-8a20-ef41835050fd"

        vm._test_appendRawEvent(senderActorID: rawRID, eventType: "output", text: "first half")
        vm._test_appendRawEvent(senderActorID: rawRID, eventType: "thinking", text: "thinking…")

        vm._test_setMemberSheetAgentsAndRelabel([makeAgent(actorID: actorID, runtimeID: rawRID)])

        XCTAssertTrue(
            vm.events.allSatisfy { $0.senderActorID == actorID },
            "all raw-runtime-id stamps in events should migrate to actor_id"
        )
    }

    func test_relabel_rebucketsStreamingBuffers() {
        let vm = SessionDetailViewModel.testInstance()
        let rawRID = "5ffcd7fc"
        let actorID = "c6205a14-actor"

        vm._test_seedStreamingBuffer(bucket: rawRID, text: "streamed so far", model: "claude-sonnet")

        vm._test_setMemberSheetAgentsAndRelabel([makeAgent(actorID: actorID, runtimeID: rawRID)])

        XCTAssertFalse(vm.streamingAgentSet.contains(rawRID))
        XCTAssertTrue(vm.streamingAgentSet.contains(actorID))
        XCTAssertEqual(vm.streamingTextByAgent[actorID], "streamed so far")
        XCTAssertNil(vm.streamingTextByAgent[rawRID])
    }

    func test_relabel_unifiesBucketsSoFeedRendersOneCompletedTurn() {
        let vm = SessionDetailViewModel.testInstance()
        let rawRID = "5ffcd7fc"
        let actorID = "c6205a14-actor"

        // Simulate the real-world bug: live MQTT event arrives first and
        // gets stamped raw; Supabase seed lands next stamped with actor_id.
        // Both are output{isComplete=true} so buildFeedItems would emit
        // two completedTurns before reconciliation.
        let liveEvent = AgentEvent(agentId: "scope", sequence: 1, eventType: "output")
        liveEvent.senderActorID = rawRID
        liveEvent.text = "live half"
        liveEvent.isComplete = true
        vm.events.append(liveEvent)

        let seedEvent = AgentEvent(agentId: "scope", sequence: 2, eventType: "output")
        seedEvent.senderActorID = actorID
        seedEvent.text = "history half"
        seedEvent.isComplete = true
        vm.events.append(seedEvent)

        // Before relabel: two distinct senderActorIDs → two completedTurns.
        let beforeFeed = buildFeedItems(vm.events)
        let beforeBuckets = Set(beforeFeed.compactMap { item -> String? in
            if case .completedTurn(_, let agentID, _, _) = item { return agentID }
            return nil
        })
        XCTAssertEqual(beforeBuckets.count, 2, "pre-relabel should have two buckets")

        vm._test_setMemberSheetAgentsAndRelabel([makeAgent(actorID: actorID, runtimeID: rawRID)])

        let afterFeed = buildFeedItems(vm.events)
        let afterBuckets = Set(afterFeed.compactMap { item -> String? in
            if case .completedTurn(_, let agentID, _, _) = item { return agentID }
            return nil
        })
        XCTAssertEqual(afterBuckets, [actorID], "post-relabel should collapse to single actor bucket")
    }

    func test_relabel_phantomCardDisappearsAfterIdleHitsCorrectBucket() {
        let vm = SessionDetailViewModel.testInstance()
        let rawRID = "5ffcd7fc"
        let actorID = "c6205a14-actor"

        // Pre-load: live stream has been mid-stream under the raw bucket.
        vm._test_seedStreamingBuffer(bucket: rawRID, text: "partial output")

        // The "phantom card" condition is that buildFeedItems would emit
        // a trailing .activeStream for the raw bucket because streaming
        // state is still open under that key.
        let beforeFeed = buildFeedItems(vm.events, streamingAgentIDs: vm.streamingAgentSet)
        XCTAssertTrue(
            beforeFeed.contains(where: {
                if case .activeStream(_, let id, _) = $0 { return id == rawRID }
                return false
            }),
            "phantom activeStream card should exist under raw runtime_id pre-relabel"
        )

        vm._test_setMemberSheetAgentsAndRelabel([makeAgent(actorID: actorID, runtimeID: rawRID)])

        // After relabel: any open stream is now under actor_id, so when a
        // statusChange:.idle arrives (resolving to actor_id via the same
        // memberSheet mapping) the buckets match and the buffer can clear.
        let afterFeed = buildFeedItems(vm.events, streamingAgentIDs: vm.streamingAgentSet)
        XCTAssertFalse(
            afterFeed.contains(where: {
                if case .activeStream(_, let id, _) = $0 { return id == rawRID }
                return false
            }),
            "no stream card should remain under the raw runtime_id"
        )
        XCTAssertTrue(
            afterFeed.contains(where: {
                if case .activeStream(_, let id, _) = $0 { return id == actorID }
                return false
            }),
            "the stream card should now key on the actor_id"
        )
    }

    func test_relabel_noopWhenMemberSheetAgentsLackRuntimeIDMapping() {
        let vm = SessionDetailViewModel.testInstance()
        let rawRID = "5ffcd7fc"

        vm._test_appendRawEvent(senderActorID: rawRID, eventType: "output", text: "x")
        // Member roster has the agent but no runtimeID — relabel must not
        // touch existing stamps.
        vm._test_setMemberSheetAgentsAndRelabel([makeAgent(actorID: "actor-x", runtimeID: nil)])

        XCTAssertEqual(vm.events.first?.senderActorID, rawRID)
    }
}
