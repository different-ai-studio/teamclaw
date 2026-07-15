import Testing
import Foundation
import SwiftData
@testable import AMUXCore

/// Streaming state-machine regressions:
///
/// 1. stop()/start() restore must cover EVERY agent that was mid-stream
///    — the old path walked a single cached incomplete-output index, so
///    in a two-agent session only the last-persisted agent's stream came
///    back and the other's text + turn id were silently dropped.
/// 2. The reconnect turn replay must not send an actor-id bucket verbatim
///    as a runtime id when the mapping can't be resolved — the daemon
///    answers an unknown runtime id with nothing and the card hangs.
///    Unroutable buckets park for one retry after the roster loads.
/// 3. The 60s isAgentWorking safety timer must not clear the flag while
///    a stream is genuinely in flight (long thinking / tool stretches),
///    closing the timer-vs-late-idle race.
@Suite("SessionDetailViewModel — stream restore, replay routing, working timer")
@MainActor
struct StreamingRestoreAndTimerTests {

    private func boundAgent(id: String, runtimeID: String?) -> MemberSheetAgent {
        MemberSheetAgent(
            id: id,
            displayName: id,
            workspacePath: "",
            agentType: "claude",
            runtimeState: .active,
            availableModels: [],
            currentModel: nil,
            runtimeID: runtimeID,
            workspaceID: nil,
            backendType: nil
        )
    }

    // MARK: - Multi-agent stop()/start() restore

    @Test("stop/start restores every mid-stream agent, not just the last persisted one")
    func multiAgentStopStartRestoresAll() throws {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "A partial", model: "model-a", turnID: "turn-a")
        vm._test_seedStreamingBuffer(bucket: "agent-b", text: "B partial", model: "model-b", turnID: "turn-b")

        let container = vm._test_makeInMemoryContainer()
        vm._test_stop(modelContext: container.mainContext)
        #expect(vm.streamingAgentSet.isEmpty, "stop() must clear all live buffers")

        vm._test_start(modelContext: container.mainContext)

        #expect(vm.streamingAgentSet == ["agent-a", "agent-b"],
                "both agents' streams must come back after stop/start")
        #expect(vm.streamingTextByAgent["agent-a"] == "A partial")
        #expect(vm.streamingTextByAgent["agent-b"] == "B partial")
        #expect(vm._test_streamingTurnIDByAgent["agent-a"] == "turn-a",
                "turn id must survive the stop()-synthetic round-trip so reconnect replay can route")
        #expect(vm._test_streamingTurnIDByAgent["agent-b"] == "turn-b")
    }

    @Test("restore drops the synthetic rows once their bytes are back in the buffers")
    func restoreConsumesSyntheticRows() throws {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "A partial", model: nil)
        vm._test_seedStreamingBuffer(bucket: "agent-b", text: "B partial", model: nil)

        let container = vm._test_makeInMemoryContainer()
        vm._test_stop(modelContext: container.mainContext)
        vm._test_start(modelContext: container.mainContext)

        #expect(!vm.events.contains { $0.eventType == "output" && !$0.isComplete },
                "synthetic incomplete rows must be absorbed, or the partial renders twice (bubble + card)")
    }

    // MARK: - Reconnect replay routing

    @Test("replay defers when the bucket's runtime id can't be resolved instead of misrouting")
    func replayDefersUnroutableBucket() async throws {
        let vm = SessionDetailViewModel.testInstance()
        let container = vm._test_makeInMemoryContainer()
        vm._test_seedStreamingBuffer(bucket: "actor-uuid-a", text: "partial", model: nil, turnID: "turn-1")
        // Roster is loaded and knows the agent, but its runtime row isn't
        // bound yet — exactly the window where the old code sent the actor
        // id as a runtime id and the daemon returned nothing.
        vm._test_setMemberSheetAgents([boundAgent(id: "actor-uuid-a", runtimeID: nil)])

        await vm._test_replayStreamingTurnsAfterReconnect(modelContext: container.mainContext)

        #expect(vm._test_pendingTurnReplayBuckets == ["actor-uuid-a"],
                "unroutable bucket must be parked for a post-roster retry")
        #expect(!vm.isSyncing,
                "requestTurnHistory must not fire with an unroutable id")
    }

    @Test("replay routing decision: resolved / roster-pending / raw runtime-id buckets")
    func replayRoutingDecision() {
        let vm = SessionDetailViewModel.testInstance()

        // Roster not loaded at all: everything defers.
        #expect(vm._test_turnReplayRuntimeID(forBucket: "actor-uuid-a") == nil)

        vm._test_setMemberSheetAgents([
            boundAgent(id: "actor-uuid-a", runtimeID: "abc12345"),
            boundAgent(id: "actor-uuid-b", runtimeID: nil),
        ])

        // Actor id with a bound runtime row → that runtime id.
        #expect(vm._test_turnReplayRuntimeID(forBucket: "actor-uuid-a") == "abc12345")
        // Known actor id without a runtime row yet → defer, never verbatim.
        #expect(vm._test_turnReplayRuntimeID(forBucket: "actor-uuid-b") == nil)
        // Unknown bucket with a loaded roster = raw runtime-id stamp from
        // the pre-memberSheet window → pass through unchanged.
        #expect(vm._test_turnReplayRuntimeID(forBucket: "rawrt1d2") == "rawrt1d2")
    }

    // MARK: - 60s working-flag safety timer

    @Test("safety timer leaves isAgentWorking alone while a stream is in flight")
    func safetyTimerSparesLiveStream() {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_seedStreamingBuffer(bucket: "agent-a", text: "still going", model: nil)
        vm._test_markAgentWorking()
        #expect(vm.isAgentWorking)

        vm._test_fireAgentWorkingSafetyTimeout()

        #expect(vm.isAgentWorking,
                "timer expiry with a non-empty streamingAgentSet must re-arm, not clear")
    }

    @Test("safety timer clears isAgentWorking when nothing is streaming")
    func safetyTimerClearsWhenIdle() {
        let vm = SessionDetailViewModel.testInstance()
        vm._test_markAgentWorking()
        #expect(vm.isAgentWorking)

        vm._test_fireAgentWorkingSafetyTimeout()

        #expect(!vm.isAgentWorking,
                "with no live stream the safety reset must still recover a missed idle")
    }
}
