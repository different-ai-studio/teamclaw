import Testing
import Foundation
import SwiftData
@testable import AMUXCore

/// Interrupt / per-agent idle settle semantics.
///
/// The old behavior cleared ALL streaming state globally on any idle or
/// interrupt — discarding the interrupted agent's partial text (the
/// reducer's idle-flush found an already-empty buffer) and wiping
/// concurrent agents' live streams. These tests pin the new contract:
/// idle settles exactly one bucket, the partial text survives as a
/// completed entry, and the ack-timeout fallback produces the same
/// result when the daemon never answers a cancel.
@Suite("SessionDetailViewModel — interrupt & per-agent idle settle")
@MainActor
struct InterruptSemanticsTests {
    private func makeContext() throws -> (SessionDetailViewModel, ModelContext) {
        let vm = SessionDetailViewModel.testInstance()
        let container = try ModelContainer(
            for: AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        return (vm, ModelContext(container))
    }

    private func idleEvent() -> Amux_AcpEvent {
        var sc = Amux_AcpStatusChange()
        sc.newStatus = .idle
        var acp = Amux_AcpEvent()
        acp.event = .statusChange(sc)
        return acp
    }

    private func outputDelta(_ text: String) -> Amux_AcpEvent {
        var o = Amux_AcpOutput()
        o.text = text
        o.isComplete = false
        var acp = Amux_AcpEvent()
        acp.event = .output(o)
        return acp
    }

    @Test("idle flushes the bucket's partial text into a completed entry")
    func idleFlushesPartialText() throws {
        let (vm, ctx) = try makeContext()
        vm._testHandleAcp(outputDelta("partial answer"), sequence: 1,
                          runtimeID: "agent-a", modelContext: ctx)
        // The @Observable mirror is throttled on the delta fast path;
        // flush before asserting on the VM-facing fields.
        vm._testFlushStreamingMirror()
        #expect(vm.streamingTextByAgent["agent-a"] == "partial answer")

        vm._testHandleAcp(idleEvent(), sequence: 2,
                          runtimeID: "agent-a", modelContext: ctx)

        #expect(vm.streamingAgentSet.isEmpty)
        let flushed = vm.events.first { $0.eventType == "output" && $0.senderActorID == "agent-a" }
        #expect(flushed?.text == "partial answer",
                "the streamed partial must survive the idle as a completed entry")
        #expect(flushed?.isComplete == true)
    }

    @Test("one agent's idle leaves a concurrent agent's stream untouched")
    func idleIsPerAgent() throws {
        let (vm, ctx) = try makeContext()
        vm._testHandleAcp(outputDelta("A says"), sequence: 1,
                          runtimeID: "agent-a", modelContext: ctx)
        vm._testHandleAcp(outputDelta("B says"), sequence: 2,
                          runtimeID: "agent-b", modelContext: ctx)
        vm._testFlushStreamingMirror()
        #expect(vm.streamingAgentSet == ["agent-a", "agent-b"])

        vm._testHandleAcp(idleEvent(), sequence: 3,
                          runtimeID: "agent-a", modelContext: ctx)

        #expect(!vm.streamingAgentSet.contains("agent-a"))
        #expect(vm.streamingAgentSet.contains("agent-b"),
                "agent-b must keep streaming after agent-a settles")
        #expect(vm.streamingTextByAgent["agent-b"] == "B says")

        // B's stream still accepts deltas afterwards.
        vm._testHandleAcp(outputDelta(" more"), sequence: 4,
                          runtimeID: "agent-b", modelContext: ctx)
        vm._testFlushStreamingMirror()
        #expect(vm.streamingTextByAgent["agent-b"] == "B says more")
    }

    @Test("ack-timeout force-settle lands the partial exactly like a real idle")
    func forceSettlePreservesPartial() throws {
        let (vm, ctx) = try makeContext()
        vm._testHandleAcp(outputDelta("half-finished"), sequence: 1,
                          runtimeID: "agent-a", modelContext: ctx)

        vm._testForceSettleInterrupt(bucket: "agent-a", modelContext: ctx)

        #expect(!vm.streamingAgentSet.contains("agent-a"))
        #expect(vm.interruptPendingAgents.isEmpty)
        let flushed = vm.events.first { $0.eventType == "output" && $0.senderActorID == "agent-a" }
        #expect(flushed?.text == "half-finished")
        #expect(flushed?.isComplete == true)
    }

    @Test("real idle resolves a pending interrupt without double-flushing")
    func idleResolvesPendingInterrupt() throws {
        let (vm, ctx) = try makeContext()
        vm._testHandleAcp(outputDelta("stop me"), sequence: 1,
                          runtimeID: "agent-a", modelContext: ctx)

        // Simulate the daemon acknowledging before the timeout fires:
        // real idle first, then the (stale) force-settle leg runs.
        vm._testHandleAcp(idleEvent(), sequence: 2,
                          runtimeID: "agent-a", modelContext: ctx)
        vm._testForceSettleInterrupt(bucket: "agent-a", modelContext: ctx)
        // _testForceSettleInterrupt re-inserts pending membership, so the
        // settle runs — the reducer's alreadyFlushed dedup must keep the
        // entry count at one.
        let flushes = vm.events.filter { $0.eventType == "output" && $0.senderActorID == "agent-a" }
        #expect(flushes.count == 1, "idle + timeout must not produce two flushed entries")
    }

    @Test("idle with an empty buffer settles without fabricating an entry")
    func emptyBufferIdleProducesNoEntry() throws {
        let (vm, ctx) = try makeContext()
        vm._testHandleAcp(idleEvent(), sequence: 1,
                          runtimeID: "agent-a", modelContext: ctx)
        #expect(vm.events.isEmpty)
        #expect(vm.streamingAgentSet.isEmpty)
    }
}
