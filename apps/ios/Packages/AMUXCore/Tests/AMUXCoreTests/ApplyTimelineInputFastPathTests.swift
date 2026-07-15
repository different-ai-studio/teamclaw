import Testing
import Foundation
import SwiftData
@testable import AMUXCore

@Suite("SessionDetailViewModel — applyTimelineInput fast path")
@MainActor
struct ApplyTimelineInputFastPathTests {
    /// Subsequent streaming deltas must skip sort + SwiftData sync.
    /// We observe this via two signals: (1) the fast-path counter
    /// increments, (2) `vm.events` stays empty (no entry was committed
    /// — the output isn't complete yet).
    @Test("subsequent streaming delta hits the fast path")
    func subsequentDeltaHitsFastPath() throws {
        SessionDetailViewModel._testFastPathSkipCount = 0
        let vm = SessionDetailViewModel.testInstance()
        let container = try ModelContainer(
            for: AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)

        // First delta — bucket not in streamingAgentSet yet, no synthetic
        // to absorb → reducer returns .streamingBufferOnly too (no entries).
        var first = Amux_AcpEvent()
        first.event = .output(makeOutput(text: "Hel", isComplete: false))
        vm._testApplyAcp(first, sequence: 1, runtimeID: "rt-1",
                         agentBucketKey: "agent-1", modelContext: ctx)
        let afterFirst = SessionDetailViewModel._testFastPathSkipCount

        // Second delta — bucket already in set, pure buffer append.
        var second = Amux_AcpEvent()
        second.event = .output(makeOutput(text: "lo", isComplete: false))
        vm._testApplyAcp(second, sequence: 2, runtimeID: "rt-1",
                         agentBucketKey: "agent-1", modelContext: ctx)

        #expect(SessionDetailViewModel._testFastPathSkipCount == afterFirst + 1)
        // The @Observable mirror is throttled on the fast path; the
        // reducer's full text lands once the pending flush runs.
        vm._testFlushStreamingMirror()
        #expect(vm.streamingTextByAgent["agent-1"] == "Hello")
        #expect(vm.events.isEmpty, "no entry committed until output is complete")
    }

    /// The throttled mirror must flush on its own (no explicit flush
    /// call) so live UI eventually sees the latest streamed text.
    @Test("throttled mirror flushes without an explicit flush")
    func throttledMirrorFlushesOnItsOwn() async throws {
        let vm = SessionDetailViewModel.testInstance()
        let container = try ModelContainer(
            for: AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)

        var first = Amux_AcpEvent()
        first.event = .output(makeOutput(text: "Hel", isComplete: false))
        vm._testApplyAcp(first, sequence: 1, runtimeID: "rt-1",
                         agentBucketKey: "agent-1", modelContext: ctx)
        var second = Amux_AcpEvent()
        second.event = .output(makeOutput(text: "lo", isComplete: false))
        vm._testApplyAcp(second, sequence: 2, runtimeID: "rt-1",
                         agentBucketKey: "agent-1", modelContext: ctx)

        // Flush interval is 100ms; poll up to 1s to keep CI tolerant.
        for _ in 0..<20 where vm.streamingTextByAgent["agent-1"] != "Hello" {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(vm.streamingTextByAgent["agent-1"] == "Hello")
    }

    /// A complete output must NOT hit the fast path — the finalised entry
    /// must land in `vm.events` via the full sort + sync path.
    @Test("complete output bypasses the fast path and projects to events")
    func completeOutputProjectsToEvents() throws {
        SessionDetailViewModel._testFastPathSkipCount = 0
        let vm = SessionDetailViewModel.testInstance()
        let container = try ModelContainer(
            for: AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)

        var delta = Amux_AcpEvent()
        delta.event = .output(makeOutput(text: "Hel", isComplete: false))
        vm._testApplyAcp(delta, sequence: 1, runtimeID: "rt-1",
                         agentBucketKey: "agent-1", modelContext: ctx)
        let afterDelta = SessionDetailViewModel._testFastPathSkipCount

        var complete = Amux_AcpEvent()
        complete.event = .output(makeOutput(text: "Hello, world", isComplete: true))
        vm._testApplyAcp(complete, sequence: 2, runtimeID: "rt-1",
                         agentBucketKey: "agent-1", modelContext: ctx)

        // Counter must not have moved — complete output takes the
        // entriesChanged path, not the streamingBufferOnly fast path.
        #expect(SessionDetailViewModel._testFastPathSkipCount == afterDelta,
                "complete output must not skip sort+sync")
        #expect(vm.events.count == 1)
        #expect(vm.events.first?.text == "Hello, world")
        #expect(vm.events.first?.isComplete == true)
    }
}

private func makeOutput(text: String, isComplete: Bool) -> Amux_AcpOutput {
    var o = Amux_AcpOutput()
    o.text = text
    o.isComplete = isComplete
    return o
}
