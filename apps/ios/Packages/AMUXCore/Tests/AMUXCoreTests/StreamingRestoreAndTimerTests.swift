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

    @Test("replay defers only while the session id is unknown")
    func replayDefersWithoutSession() async throws {
        // The old three-way decision (bound runtime / roster-pending / raw
        // stamp) existed because the replay address had to be discovered.
        // It is now derived from (agent actor, session), so the only thing
        // that can be missing is the session itself.
        let vm = SessionDetailViewModel.testInstance()
        #expect(vm._test_turnReplayRuntimeID(forBucket: "actor-uuid-a") == nil,
                "no session bound yet — defer rather than address nothing")
    }

    @Test("replay addresses every bucket as {actor}::{session}")
    func replayRoutingDecision() {
        let session = Session(sessionId: "session-1", teamId: "test-team")
        let vm = SessionDetailViewModel.testInstance(session: session)

        // No roster needed: buckets are agent actor ids straight off the
        // envelope, so the address is a pure derivation.
        #expect(vm._test_turnReplayRuntimeID(forBucket: "actor-uuid-a")
                == "actor-uuid-a::session-1")
        #expect(vm._test_turnReplayRuntimeID(forBucket: "actor-uuid-b")
                == "actor-uuid-b::session-1",
                "a second agent must get its own address, never the first's")
        #expect(vm._test_turnReplayRuntimeID(forBucket: "") == nil,
                "an empty bucket must not produce a `::session-1` address")
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
