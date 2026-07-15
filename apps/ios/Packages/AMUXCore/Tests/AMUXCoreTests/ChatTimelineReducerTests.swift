import Testing
import Foundation
@testable import AMUXCore

// MARK: - ChatTimelineReducer fixture tests
//
// These tests pin the seven in-place mutation cases documented in
// `TimelineInput.swift` against synthetic inputs. They run without
// SwiftData / MQTT / SwiftUI; the reducer is a pure function over a
// value-type `TimelineState`.
//
// When the production migration off the inline SessionDetailViewModel
// handler lands (Phase 4 main), these scenarios should still pass
// against any recorded session traces — see project_phase4_status.md.

@Suite("ChatTimelineReducer — streaming output (case 1)")
struct ReducerStreamingOutputTests {
    @Test("first delta opens the stream and seeds the per-agent buffer")
    func firstDeltaOpensStream() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "Hel", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: acp)),
            to: &state
        )
        #expect(state.streamingAgentSet.contains("agent-1"))
        #expect(state.streamingTextByAgent["agent-1"] == "Hel")
        #expect(state.entries.isEmpty,
                "streaming deltas don't create entries until finalised")
    }

    @Test("subsequent deltas append onto the open stream's buffer")
    func deltasAppend() {
        var state = TimelineState()
        for chunk in ["Hel", "lo,", " world"] {
            var acp = Amux_AcpEvent()
            acp.event = .output(makeOutput(text: chunk, isComplete: false))
            ChatTimelineReducer.apply(
                .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                              agentBucketKey: "agent-1", timestamp: .now,
                              acpEvent: acp)),
                to: &state
            )
        }
        #expect(state.streamingTextByAgent["agent-1"] == "Hello, world")
    }

    @Test("complete output finalises the stream and clears the buffer")
    func completeFinalises() {
        var state = TimelineState()
        // Seed an open stream.
        var delta = Amux_AcpEvent()
        delta.event = .output(makeOutput(text: "Hel", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: delta)),
            to: &state
        )
        // Final.
        var done = Amux_AcpEvent()
        done.event = .output(makeOutput(text: "Hello, world", isComplete: true))
        done.model = "claude-opus-4-7"
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: done)),
            to: &state
        )
        #expect(!state.streamingAgentSet.contains("agent-1"))
        #expect(state.streamingTextByAgent["agent-1"] == nil)
        #expect(state.entries.count == 1)
        #expect(state.entries[0].text == "Hello, world")
        #expect(state.entries[0].isComplete)
        #expect(state.entries[0].model == "claude-opus-4-7")
    }

    @Test("first delta captures the active turn id; idle clears it")
    func streamingTurnIDLifecycle() {
        var state = TimelineState()
        // First delta — should populate streamingTurnIDByAgent.
        var delta = Amux_AcpEvent()
        delta.event = .output(makeOutput(text: "Hel", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-xyz",
                          acpEvent: delta)),
            to: &state
        )
        #expect(state.streamingTurnIDByAgent["agent-1"] == "turn-xyz",
                "turn id from the first delta lets the reconnect replay path target this turn")

        // Subsequent partials don't disturb it.
        var more = Amux_AcpEvent()
        more.event = .output(makeOutput(text: "lo", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-xyz",
                          acpEvent: more)),
            to: &state
        )
        #expect(state.streamingTurnIDByAgent["agent-1"] == "turn-xyz")

        // Idle clears, alongside the rest of the streaming state.
        var idle = Amux_AcpEvent()
        idle.event = .statusChange(makeStatusChange(.idle))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 3, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-xyz",
                          acpEvent: idle)),
            to: &state
        )
        #expect(state.streamingTurnIDByAgent["agent-1"] == nil)
        #expect(!state.streamingAgentSet.contains("agent-1"))
    }

    @Test("two agents stream concurrently without bucket cross-contamination")
    func concurrentBuckets() {
        var state = TimelineState()
        var aDelta = Amux_AcpEvent()
        aDelta.event = .output(makeOutput(text: "A: ", isComplete: false))
        var bDelta = Amux_AcpEvent()
        bDelta.event = .output(makeOutput(text: "B: ", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          acpEvent: aDelta)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-b",
                          agentBucketKey: "agent-b", timestamp: .now,
                          acpEvent: bDelta)),
            to: &state
        )
        var aDelta2 = Amux_AcpEvent()
        aDelta2.event = .output(makeOutput(text: "hi", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 3, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          acpEvent: aDelta2)),
            to: &state
        )
        #expect(state.streamingTextByAgent["agent-a"] == "A: hi")
        #expect(state.streamingTextByAgent["agent-b"] == "B: ",
                "second agent's buffer must not be touched by agent-a's deltas")
    }
}

@Suite("ChatTimelineReducer — tool result pairing (case 2)")
struct ReducerToolResultPairingTests {
    @Test("toolResult pairs with prior toolUse by toolID and marks it complete")
    func pairsWithPriorToolUse() {
        var state = TimelineState()
        var use = Amux_AcpEvent()
        use.event = .toolUse(makeToolUse(toolID: "t-1", toolName: "Read", description: "reading"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: use)),
            to: &state
        )
        var result = Amux_AcpEvent()
        result.event = .toolResult(makeToolResult(toolID: "t-1", success: true, summary: "ok"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: result)),
            to: &state
        )
        #expect(state.entries.count == 1, "tool_use stays as the single entry; tool_result lands in place")
        #expect(state.entries[0].eventType == "tool_use")
        #expect(state.entries[0].isComplete)
        #expect(state.entries[0].success == true)
        #expect(state.entries[0].resultSummary == "ok",
                "toolResult summary text must land on the paired tool_use so the detail card can render it")
    }

    @Test("later toolUse update fills in grep arguments without appending")
    func laterToolUseUpdateFillsArguments() {
        var state = TimelineState()
        var initial = Amux_AcpEvent()
        initial.event = .toolUse(makeToolUse(toolID: "t-grep", toolName: "grep", description: ""))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: initial)),
            to: &state
        )
        var update = Amux_AcpEvent()
        update.event = .toolUse(makeToolUse(toolID: "t-grep", toolName: "", description: #"{"pattern":"MQTT","path":"apps/daemon"}"#))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: update)),
            to: &state
        )

        #expect(state.entries.count == 1)
        #expect(state.entries[0].toolName == "grep")
        #expect(state.entries[0].text == #"{"pattern":"MQTT","path":"apps/daemon"}"#)
    }

    @Test("out-of-order toolResult appends a standalone entry")
    func outOfOrderToolResult() {
        var state = TimelineState()
        var result = Amux_AcpEvent()
        result.event = .toolResult(makeToolResult(toolID: "t-orphan", success: false, summary: "fail"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: result)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].eventType == "tool_result")
    }

    @Test("toolUse arriving mid-stream flushes the buffered text as a complete output entry")
    func toolUseFlushesPendingStreamText() {
        var state = TimelineState()
        // Two streaming deltas land in the per-agent buffer.
        for chunk in ["I'll ", "use the Read tool. "] {
            var delta = Amux_AcpEvent()
            delta.event = .output(makeOutput(text: chunk, isComplete: false))
            ChatTimelineReducer.apply(
                .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                              agentBucketKey: "agent", timestamp: .now,
                              turnID: "turn-A",
                              acpEvent: delta)),
                to: &state
            )
        }
        #expect(state.streamingTextByAgent["agent"] == "I'll use the Read tool. ")
        #expect(state.entries.isEmpty)

        // ToolUse cuts in. The buffered prefix must persist as its own
        // complete output entry (segment 1) BEFORE the tool_use row so
        // the detail view can render text → tool, not all-tools-then-text.
        var use = Amux_AcpEvent()
        use.event = .toolUse(makeToolUse(toolID: "t-1", toolName: "Read", description: "reading SKILL.md"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 5, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "turn-A",
                          acpEvent: use)),
            to: &state
        )

        #expect(state.entries.count == 2,
                "mid-turn flush must persist the buffered text as a per-segment output entry alongside the new tool_use")
        let segment = state.entries[0]
        #expect(segment.eventType == "output")
        #expect(segment.text == "I'll use the Read tool. ")
        #expect(segment.isComplete)
        #expect(segment.turnID == "turn-A")
        #expect(segment.sequence == 0,
                "synthetic segment must not borrow the ToolUse envelope's sequence — the sequence dedupe would otherwise swallow the originating tool envelope on replay")
        #expect(state.entries[1].eventType == "tool_use")
        #expect(state.streamingTextByAgent["agent"] == nil,
                "buffer must be cleared so the next delta starts a fresh segment")
        #expect(state.streamingAgentSet.contains("agent"),
                "turn is still in flight, so the streaming flag must stay set")
    }

    @Test("ToolUse flush skips the synthetic segment when an identical one already exists")
    func toolUseFlushDedupesOnReplay() {
        var state = TimelineState()
        // First pass: seed deltas + ToolUse.
        var d1 = Amux_AcpEvent()
        d1.event = .output(makeOutput(text: "thinking aloud ", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "turn-X",
                          acpEvent: d1)),
            to: &state
        )
        var use = Amux_AcpEvent()
        use.event = .toolUse(makeToolUse(toolID: "t-1", toolName: "Read", description: "reading"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "turn-X",
                          acpEvent: use)),
            to: &state
        )
        #expect(state.entries.count == 2)

        // Daemon restart renumbers sequence space but keeps the same
        // turn_id. The Output delta re-seeds the streaming buffer, the
        // ToolUse handler hits my flush logic again — but the same
        // (bucket, turnID, text) segment already exists, so the
        // synthetic entry must be skipped. The replayed ToolUse merges
        // back onto the existing tool_use row via toolID, not append.
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 50, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "turn-X",
                          acpEvent: d1)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 100, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "turn-X",
                          acpEvent: use)),
            to: &state
        )
        #expect(state.entries.count == 2,
                "replayed deltas + ToolUse must dedupe against the existing per-segment entry")
        #expect(state.entries.filter { $0.eventType == "output" }.count == 1)
        #expect(state.entries.filter { $0.eventType == "tool_use" }.count == 1)
    }
}

@Suite("ChatTimelineReducer — plan replace (case 3)")
struct ReducerPlanReplaceTests {
    @Test("a second plan_update replaces the first entry's text in place")
    func replacesInPlace() {
        var state = TimelineState()
        var first = Amux_AcpEvent()
        first.event = .planUpdate(makePlanUpdate([("plan", "pending")]))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: first)),
            to: &state
        )
        var second = Amux_AcpEvent()
        second.event = .planUpdate(makePlanUpdate([("plan", "completed"),
                                                   ("ship", "in_progress")]))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: second)),
            to: &state
        )
        #expect(state.entries.count == 1,
                "plan_update is a snapshot replacement, not an append")
        #expect(state.entries[0].text?.contains("[done] plan") == true)
        #expect(state.entries[0].text?.contains("[wip] ship") == true)
    }

    @Test("plan_update replacement is scoped to the emitting agent")
    func replacesPerAgent() {
        var state = TimelineState()
        var agentA = Amux_AcpEvent()
        agentA.event = .planUpdate(makePlanUpdate([("a-old", "in_progress")]))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          acpEvent: agentA)),
            to: &state
        )

        var agentB = Amux_AcpEvent()
        agentB.event = .planUpdate(makePlanUpdate([("b-task", "in_progress")]))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-b",
                          agentBucketKey: "agent-b", timestamp: .now,
                          acpEvent: agentB)),
            to: &state
        )

        var agentANext = Amux_AcpEvent()
        agentANext.event = .planUpdate(makePlanUpdate([("a-done", "completed")]))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          acpEvent: agentANext)),
            to: &state
        )

        #expect(state.entries.count == 2)
        #expect(state.entries.first(where: { $0.senderActorID == "agent-a" })?.text == "[done] a-done")
        #expect(state.entries.first(where: { $0.senderActorID == "agent-b" })?.text == "[wip] b-task")
    }
}

@Suite("ChatTimelineReducer — permission resolve (case 4)")
struct ReducerPermissionResolveTests {
    @Test("resolution updates the matching permission_request in place")
    func updatesInPlace() {
        var state = TimelineState()
        var request = Amux_AcpEvent()
        request.event = .permissionRequest(makePermissionRequest(requestID: "p-1",
                                                                 toolName: "Bash",
                                                                 description: "rm -rf /"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: request)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .permissionResolution(PermissionResolutionInput(requestID: "p-1", granted: false)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].eventType == "permission_request")
        #expect(state.entries[0].isComplete)
        #expect(state.entries[0].success == false)
    }

    @Test("resolution without a matching request is dropped silently")
    func orphanResolutionDropped() {
        var state = TimelineState()
        ChatTimelineReducer.apply(
            .permissionResolution(PermissionResolutionInput(requestID: "p-orphan", granted: true)),
            to: &state
        )
        #expect(state.entries.isEmpty)
    }
}

@Suite("ChatTimelineReducer — status change idle flush (case 5)")
struct ReducerStatusChangeIdleTests {
    @Test("idle status flushes the open stream buffer to a final output entry")
    func idleFlushesBuffer() {
        var state = TimelineState()
        var delta = Amux_AcpEvent()
        delta.event = .output(makeOutput(text: "partial", isComplete: false))
        delta.model = "claude-sonnet-4-6"
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: delta)),
            to: &state
        )
        var idle = Amux_AcpEvent()
        idle.event = .statusChange(makeStatusChange(.idle))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: idle)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].eventType == "output")
        #expect(state.entries[0].text == "partial")
        #expect(state.entries[0].isComplete)
        #expect(state.entries[0].model == "claude-sonnet-4-6")
        #expect(state.streamingAgentSet.isEmpty)
    }

    @Test("idle for one agent leaves the other agent's stream open")
    func idleIsBucketScoped() {
        var state = TimelineState()
        var aDelta = Amux_AcpEvent()
        aDelta.event = .output(makeOutput(text: "a", isComplete: false))
        var bDelta = Amux_AcpEvent()
        bDelta.event = .output(makeOutput(text: "b", isComplete: false))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          acpEvent: aDelta)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-b",
                          agentBucketKey: "agent-b", timestamp: .now,
                          acpEvent: bDelta)),
            to: &state
        )
        var idleA = Amux_AcpEvent()
        idleA.event = .statusChange(makeStatusChange(.idle))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 3, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          acpEvent: idleA)),
            to: &state
        )
        #expect(!state.streamingAgentSet.contains("agent-a"))
        #expect(state.streamingAgentSet.contains("agent-b"),
                "agent-b's stream must survive agent-a's idle")
    }
}

@Suite("ChatTimelineReducer — local prompt + live echo merge (case 6)")
struct ReducerLocalEchoMergeTests {
    @Test("local prompt creates an entry that the live echo merges into")
    func localEchoMerges() {
        var state = TimelineState()
        let clientID = "client-uuid-xyz"
        ChatTimelineReducer.apply(
            .localPrompt(LocalPromptInput(clientID: clientID,
                                          senderActorID: "user-1",
                                          content: "hi",
                                          createdAt: Date(timeIntervalSince1970: 100))),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].clientID == clientID)

        ChatTimelineReducer.apply(
            .liveMessage(LiveMessageInput(messageID: "msg-server-1",
                                          clientLocalID: clientID,
                                          senderActorID: "user-1",
                                          content: "hi",
                                          createdAt: Date(timeIntervalSince1970: 101))),
            to: &state
        )
        #expect(state.entries.count == 1, "no duplicate entry from the live echo")
        #expect(state.entries[0].id == "msg-server-1",
                "id swaps to the server-assigned messageID")
        #expect(state.entries[0].clientID == nil,
                "clientID is cleared once the server id takes over")
    }

    @Test("live message without a matching clientLocalID appends a new entry")
    func liveMessageWithoutMergeAppends() {
        var state = TimelineState()
        ChatTimelineReducer.apply(
            .liveMessage(LiveMessageInput(messageID: "msg-1",
                                          clientLocalID: nil,
                                          senderActorID: "user-2",
                                          content: "another user",
                                          createdAt: Date())),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].id == "msg-1")
    }
}

@Suite("ChatTimelineReducer — history + live cross-dedupe (case 7)")
struct ReducerHistoryCrossDedupeTests {
    @Test("history seed backfills supabaseMessageID onto a matching live entry")
    func backfillsExistingEntry() {
        var state = TimelineState()
        // Live stream completes first.
        var done = Amux_AcpEvent()
        done.event = .output(makeOutput(text: "Hello", isComplete: true))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          acpEvent: done)),
            to: &state
        )
        // History seed arrives later for the same turn.
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-1",
                                         kind: .output,
                                         senderActorID: "agent",
                                         content: "Hello",
                                         createdAt: .now)),
            to: &state
        )
        #expect(state.entries.count == 1,
                "history seed must not insert a duplicate output entry")
        #expect(state.entries[0].supabaseMessageID == "sb-1")
    }

    @Test("repeated history seed with a new row id does not duplicate same output")
    func repeatedHistorySeedWithNewRowIDDoesNotDuplicateSameOutput() {
        var state = TimelineState(entries: [
            TimelineEntry(
                eventType: "output",
                text: "same reply",
                isComplete: true,
                senderActorID: "agent",
                timestamp: Date(timeIntervalSince1970: 1),
                supabaseMessageID: "sb-existing"
            )
        ])

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-new",
                                         kind: .output,
                                         senderActorID: "agent",
                                         content: "same reply",
                                         createdAt: Date(timeIntervalSince1970: 2))),
            to: &state
        )

        #expect(state.entries.count == 1,
                "same agent output content must stay one bubble even if Supabase returns another row id")
    }

    @Test("history seed replaces same-agent local output prefix with full persisted reply")
    func historySeedReplacesSameAgentLocalOutputPrefix() {
        var state = TimelineState(entries: [
            TimelineEntry(
                eventType: "output",
                text: "I found the existing iOS pieces:",
                isComplete: true,
                senderActorID: "agent",
                timestamp: Date(timeIntervalSince1970: 2)
            )
        ])

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "sb-full",
                kind: .output,
                senderActorID: "agent",
                content: "I found the existing iOS pieces:\n- CreateIdeaSheet\n- AttachmentUploadManager",
                createdAt: Date(timeIntervalSince1970: 1),
                model: "codex",
                turnID: "turn-1"
            )),
            to: &state
        )

        #expect(state.entries.count == 1,
                "Supabase full reply must replace the shorter live/local prefix instead of rendering twice")
        #expect(state.entries[0].text == "I found the existing iOS pieces:\n- CreateIdeaSheet\n- AttachmentUploadManager")
        #expect(state.entries[0].supabaseMessageID == "sb-full")
        #expect(state.entries[0].turnID == "turn-1")
    }

    @Test("history seed merges local prompt by outbox id before content")
    func historyMergesLocalPromptByOutboxId() {
        var state = TimelineState(entries: [
            TimelineEntry(
                eventType: "user_prompt",
                text: "same",
                isComplete: true,
                senderActorID: "user-1",
                timestamp: Date(timeIntervalSince1970: 1),
                outboxMessageID: "msg-old"
            ),
            TimelineEntry(
                eventType: "user_prompt",
                text: "same",
                isComplete: true,
                senderActorID: "user-1",
                timestamp: Date(timeIntervalSince1970: 2),
                outboxMessageID: "msg-new"
            )
        ])

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "msg-new",
                                         kind: .userPrompt,
                                         senderActorID: "user-1",
                                         content: "same",
                                         createdAt: Date(timeIntervalSince1970: 3))),
            to: &state
        )

        #expect(state.entries.count == 2)
        #expect(state.entries[0].supabaseMessageID == nil)
        #expect(state.entries[1].supabaseMessageID == "msg-new")
    }

    @Test("re-seeding the same supabase id is idempotent")
    func reSeedIdempotent() {
        var state = TimelineState()
        let input = HistoryInput(supabaseMessageID: "sb-1",
                                 kind: .userPrompt,
                                 senderActorID: "user-1",
                                 content: "hi",
                                 createdAt: .now)
        ChatTimelineReducer.apply(.historyMessage(input), to: &state)
        ChatTimelineReducer.apply(.historyMessage(input), to: &state)
        #expect(state.entries.count == 1)
    }

    @Test("re-seeding the same supabase id corrects stale local timestamp")
    func reSeedCorrectsStaleTimestamp() {
        var state = TimelineState(entries: [
            TimelineEntry(
                eventType: "user_prompt",
                text: "112121212",
                isComplete: true,
                senderActorID: "user-1",
                timestamp: Date(timeIntervalSince1970: 200),
                supabaseMessageID: "msg-first"
            )
        ])

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "msg-first",
                kind: .userPrompt,
                senderActorID: "user-1",
                content: "112121212",
                createdAt: Date(timeIntervalSince1970: 100)
            )),
            to: &state
        )

        #expect(state.entries.count == 1)
        #expect(state.entries[0].timestamp == Date(timeIntervalSince1970: 100))
    }

    @Test("history seed corrects placeholder prompt timestamp")
    func historyCorrectsPlaceholderPromptTimestamp() {
        var state = TimelineState(entries: [
            TimelineEntry(
                eventType: "user_prompt",
                text: "112121212",
                isComplete: true,
                senderActorID: "user-1",
                timestamp: Date(timeIntervalSince1970: 200)
            ),
            TimelineEntry(
                eventType: "output",
                text: "reply",
                isComplete: true,
                senderActorID: "agent-1",
                timestamp: Date(timeIntervalSince1970: 150)
            )
        ])

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "msg-first",
                kind: .userPrompt,
                senderActorID: "user-1",
                content: "112121212",
                createdAt: Date(timeIntervalSince1970: 100)
            )),
            to: &state
        )

        state.entries.sort { $0.timestamp < $1.timestamp }
        #expect(state.entries.count == 2)
        #expect(state.entries[0].eventType == "user_prompt")
        #expect(state.entries[0].timestamp == Date(timeIntervalSince1970: 100))
        #expect(state.entries[1].eventType == "output")
    }
}

// MARK: - turn_id history segments (case 8)

@Suite("ChatTimelineReducer — history per-segment turns (case 8)")
struct ReducerHistoryTurnMergeTests {
    @Test("two AgentReply rows with same turn_id stay as separate entries")
    func sameTurnStaysAsSeparateEntries() {
        var state = TimelineState()
        let t0 = Date(timeIntervalSince1970: 1_000)
        let t1 = Date(timeIntervalSince1970: 1_001)
        // First flush (mid-turn ToolUse cut).
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-1",
                                          kind: .output,
                                          senderActorID: "agent",
                                          content: "I'll use the Read tool. ",
                                          createdAt: t0,
                                          turnID: "turn-A")),
            to: &state
        )
        // Second flush (Active→Idle continuation).
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-2",
                                          kind: .output,
                                          senderActorID: "agent",
                                          content: "Now I see — the answer is 42.",
                                          createdAt: t1,
                                          turnID: "turn-A")),
            to: &state
        )
        #expect(state.entries.count == 2,
                "multi-segment turn must keep per-segment entries so the detail view can interleave text + tools")
        #expect(state.entries[0].text == "I'll use the Read tool. ")
        #expect(state.entries[1].text == "Now I see — the answer is 42.")
        #expect(state.entries.allSatisfy { $0.turnID == "turn-A" })
    }

    @Test("different turn_id keeps rows separate")
    func differentTurnStaysSeparate() {
        var state = TimelineState()
        let t0 = Date(timeIntervalSince1970: 2_000)
        let t1 = Date(timeIntervalSince1970: 2_001)
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-a",
                                          kind: .output,
                                          senderActorID: "agent",
                                          content: "first turn reply",
                                          createdAt: t0,
                                          turnID: "turn-X")),
            to: &state
        )
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-b",
                                          kind: .output,
                                          senderActorID: "agent",
                                          content: "second turn reply",
                                          createdAt: t1,
                                          turnID: "turn-Y")),
            to: &state
        )
        #expect(state.entries.count == 2, "distinct turnIDs must not merge")
    }

    @Test("nil turn_id falls back to per-row entries (legacy rows)")
    func nilTurnIDFallsBack() {
        var state = TimelineState()
        let t0 = Date(timeIntervalSince1970: 3_000)
        let t1 = Date(timeIntervalSince1970: 3_001)
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-old-1",
                                          kind: .output,
                                          senderActorID: "agent",
                                          content: "old row 1",
                                          createdAt: t0,
                                          turnID: nil)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(supabaseMessageID: "sb-old-2",
                                          kind: .output,
                                          senderActorID: "agent",
                                          content: "old row 2",
                                          createdAt: t1,
                                          turnID: nil)),
            to: &state
        )
        #expect(state.entries.count == 2,
                "nil turnID must not collapse legacy rows together")
    }
}

// MARK: - ACP turn-id dedupe (Bug 2 regression guard)

@Suite("ChatTimelineReducer — ACP turn-id dedupe")
struct ReducerAcpTurnIDDedupeTests {
    /// Daemon restart renumbers `sequence` while keeping `turn_id` stable.
    /// Without the turnID dedupe path, the second arrival appends a second
    /// completed bubble — the multi-arrival 7× duplication the user
    /// reported on iOS session detail.
    @Test("same (bucket, turnID) complete output dedupes across renumbered sequences")
    func sameTurnIDDedupesAcrossSequences() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "BUILD SUCCEEDED", isComplete: true))

        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 42,
                          runtimeID: "rt-1",
                          agentBucketKey: "agent-1",
                          timestamp: .now,
                          turnID: "turn-abc",
                          acpEvent: acp)),
            to: &state
        )
        // Daemon restart → same logical event replays with new sequence.
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 9,
                          runtimeID: "rt-1",
                          agentBucketKey: "agent-1",
                          timestamp: .now,
                          turnID: "turn-abc",
                          acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 1,
                "turn-id replay must not produce a second bubble")
        #expect(state.entries.first?.text == "BUILD SUCCEEDED")
        #expect(state.entries.first?.turnID == "turn-abc")
    }

    /// The same agent legitimately repeating the same text in two
    /// different turns (e.g. "好的" or "BUILD SUCCEEDED" on two builds)
    /// must remain two separate bubbles. This is exactly the scenario
    /// content-based dedupe would have wrongly collapsed.
    @Test("different turnIDs with identical content stay as two entries")
    func differentTurnIDsWithSameContentStayDistinct() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "好的", isComplete: true))

        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-1", acpEvent: acp)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-2", acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 2,
                "legitimate same-content replies in different turns must coexist")
    }

    /// Same bucket+content but DIFFERENT bucket (different agent) — still
    /// two entries, since bucket identity also separates.
    @Test("same turnID but different buckets stay distinct")
    func sameTurnIDDifferentBuckets() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "done", isComplete: true))

        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-a",
                          agentBucketKey: "agent-a", timestamp: .now,
                          turnID: "turn-1", acpEvent: acp)),
            to: &state
        )
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-b",
                          agentBucketKey: "agent-b", timestamp: .now,
                          turnID: "turn-1", acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 2)
    }

    /// Nil/empty turnID falls back to sequence dedupe — backwards-compatible
    /// for envelopes from a pre-turn_id daemon.
    @Test("nil turnID falls back to sequence-based dedupe")
    func nilTurnIDFallsBackToSequenceDedupe() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "legacy", isComplete: true))

        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 5, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: nil, acpEvent: acp)),
            to: &state
        )
        // Same sequence — sequence dedupe still catches it.
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 5, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: nil, acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 1)
        // Different sequence + nil turnID — fallback can't dedupe, expected
        // duplicate. Documenting the regression boundary: only daemons that
        // stamp turn_id get the cross-restart guarantee.
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 6, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: nil, acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 2)
    }

    /// `stop()`-saved synthetic incomplete output gets the turnID
    /// backfilled when the live completion arrives, so subsequent replays
    /// with the same turnID dedupe correctly.
    @Test("incomplete-output completion backfills turnID for future replays")
    func incompleteCompletionBackfillsTurnID() {
        var state = TimelineState()
        // Seed: existing incomplete entry without a turnID (pre-stop saved row).
        state.entries.append(TimelineEntry(
            id: "synthetic-1",
            sequence: 0,
            eventType: "output",
            text: "partial",
            isComplete: false,
            senderActorID: "agent-1",
            timestamp: .now
        ))

        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "partial+final", isComplete: true))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 10, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-z", acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].isComplete)
        #expect(state.entries[0].turnID == "turn-z",
                "completion must stamp turnID on the prior incomplete row")

        // Now replay the same logical event with renumbered sequence — the
        // turnID guard catches it.
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 3, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now,
                          turnID: "turn-z", acpEvent: acp)),
            to: &state
        )
        #expect(state.entries.count == 1, "replay must dedupe via backfilled turnID")
    }
}

// MARK: - History-seed streaming cleanup (Bug 1 regression guard)

@Suite("ChatTimelineReducer — history seed clears stale streaming state")
struct ReducerHistorySeedClearsStreamingTests {
    /// User left a session mid-stream; `stop()` saved a synthetic incomplete
    /// output. On reopen, `start()` restored `streamingAgentSet[bucket]` +
    /// `streamingTextByAgent[bucket]` from that sentinel. By then the daemon
    /// had actually completed the turn and persisted it to Supabase. The
    /// history seed must remove the stale typing indicator so the user
    /// sees the completed bubble instead of a perpetual loading state.
    @Test("complete output history clears matching streaming buckets")
    func completeOutputClearsStreaming() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        state.streamingTextByAgent["agent-1"] = "Hello par"
        state.streamingModelByAgent["agent-1"] = "claude-sonnet-4-6"

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "sb-1",
                kind: .output,
                senderActorID: "agent-1",
                content: "Hello partial then the rest of the message",
                createdAt: .now,
                model: "claude-sonnet-4-6",
                turnID: "turn-x"
            )),
            to: &state
        )

        #expect(!state.streamingAgentSet.contains("agent-1"),
                "completed turn must remove the typing indicator")
        #expect(state.streamingTextByAgent["agent-1"] == nil)
        #expect(state.streamingModelByAgent["agent-1"] == nil)
        #expect(state.entries.count == 1)
        #expect(state.entries[0].isComplete)
    }

    /// Edge case: agent finished one turn AND is now actively streaming a
    /// brand-new, unrelated turn. The history seed for the OLD turn must
    /// not stomp the active stream's typing indicator. We distinguish by
    /// checking whether the streaming partial is a prefix of the seeded
    /// completed text.
    @Test("history seed leaves unrelated active stream alone")
    func unrelatedActiveStreamSurvives() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        // Partial is from a DIFFERENT, brand-new turn — does NOT prefix
        // the historical completion below.
        state.streamingTextByAgent["agent-1"] = "Different new turn so far"

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "sb-old",
                kind: .output,
                senderActorID: "agent-1",
                content: "Old completed message content",
                createdAt: .now,
                turnID: "turn-old"
            )),
            to: &state
        )

        #expect(state.streamingAgentSet.contains("agent-1"),
                "active stream must survive history seed of an unrelated old turn")
        #expect(state.streamingTextByAgent["agent-1"] == "Different new turn so far")
    }

    /// User-prompt history rows never touch streaming state, because the
    /// indicator belongs to the agent side.
    @Test("history user_prompt does not touch streaming state")
    func userPromptDoesNotTouchStreaming() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        state.streamingTextByAgent["agent-1"] = "agent partial"

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "sb-prompt",
                kind: .userPrompt,
                senderActorID: "human-1",
                content: "Hi",
                createdAt: .now
            )),
            to: &state
        )

        #expect(state.streamingAgentSet.contains("agent-1"))
        #expect(state.streamingTextByAgent["agent-1"] == "agent partial")
    }

    /// Empty streaming partial (e.g., `stop()` saved an empty buffer) still
    /// clears — empty is trivially a prefix of any completed text and a
    /// streaming-set entry with no partial is a stuck indicator we want gone.
    @Test("empty streaming partial still clears")
    func emptyPartialClears() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        // No streamingTextByAgent entry at all.

        ChatTimelineReducer.apply(
            .historyMessage(HistoryInput(
                supabaseMessageID: "sb-1",
                kind: .output,
                senderActorID: "agent-1",
                content: "anything",
                createdAt: .now
            )),
            to: &state
        )

        #expect(!state.streamingAgentSet.contains("agent-1"))
    }
}

@Suite("ChatTimelineReducer — turnID propagation on tool / thinking entries")
struct ReducerTurnIDPropagationTests {
    @Test("toolUse entry carries the envelope's turnID")
    func toolUseStampsTurnID() {
        var state = TimelineState()
        var use = Amux_AcpEvent()
        use.event = .toolUse(makeToolUse(toolID: "t-1", toolName: "Bash", description: "cd /tmp"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "TURN-42",
                          acpEvent: use)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].eventType == "tool_use")
        #expect(state.entries[0].turnID == "TURN-42",
                "tool_use entry must carry turnID so buildFeedItems can fold it into the same bubble as the turn's output")
    }

    @Test("thinking entry carries the envelope's turnID")
    func thinkingStampsTurnID() {
        var state = TimelineState()
        var think = Amux_AcpEvent()
        var t = Amux_AcpThinking()
        t.text = "let me think"
        think.event = .thinking(t)
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "TURN-42",
                          acpEvent: think)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].eventType == "thinking")
        #expect(state.entries[0].turnID == "TURN-42")
    }

    @Test("out-of-order toolResult entry carries the envelope's turnID")
    func standaloneToolResultStampsTurnID() {
        var state = TimelineState()
        var result = Amux_AcpEvent()
        result.event = .toolResult(makeToolResult(toolID: "t-orphan", success: true, summary: "ok"))
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .now,
                          turnID: "TURN-42",
                          acpEvent: result)),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].eventType == "tool_result")
        #expect(state.entries[0].turnID == "TURN-42")
    }
}

// MARK: - Helpers building Amux_AcpEvent sub-payloads

private func makeOutput(text: String, isComplete: Bool) -> Amux_AcpOutput {
    var o = Amux_AcpOutput()
    o.text = text
    o.isComplete = isComplete
    return o
}

private func makeToolUse(toolID: String, toolName: String, description: String) -> Amux_AcpToolUse {
    var t = Amux_AcpToolUse()
    t.toolID = toolID
    t.toolName = toolName
    t.description_p = description
    return t
}

private func makeToolResult(toolID: String, success: Bool, summary: String) -> Amux_AcpToolResult {
    var r = Amux_AcpToolResult()
    r.toolID = toolID
    r.success = success
    r.summary = summary
    return r
}

private func makePermissionRequest(requestID: String, toolName: String, description: String) -> Amux_AcpPermissionRequest {
    var p = Amux_AcpPermissionRequest()
    p.requestID = requestID
    p.toolName = toolName
    p.description_p = description
    return p
}

private func makeStatusChange(_ newStatus: Amux_AgentStatus) -> Amux_AcpStatusChange {
    var s = Amux_AcpStatusChange()
    s.newStatus = newStatus
    return s
}

private func makePlanUpdate(_ items: [(String, String)]) -> Amux_AcpPlanUpdate {
    var u = Amux_AcpPlanUpdate()
    u.entries = items.map { content, status in
        var e = Amux_AcpPlanEntry()
        e.content = content
        e.status = status
        return e
    }
    return u
}

// MARK: - TimelineReducerEffect return value tests

@Suite("ChatTimelineReducer — TimelineReducerEffect return value")
struct ReducerEffectReturnTests {
    @Test("subsequent streaming delta returns .streamingBufferOnly")
    func subsequentDeltaReturnsBufferOnly() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        state.streamingTextByAgent["agent-1"] = "Hel"
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "lo", isComplete: false))
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .streamingBufferOnly)
        #expect(state.streamingTextByAgent["agent-1"] == "Hello")
    }

    @Test("first delta with synthetic entry returns .entriesChanged")
    func firstDeltaWithSyntheticReturnsEntriesChanged() {
        var state = TimelineState()
        state.entries = [
            TimelineEntry(id: "syn-1", eventType: "output", text: "partial",
                          isComplete: false, senderActorID: "agent-1", timestamp: .now)
        ]
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "more", isComplete: false))
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .entriesChanged)
        #expect(state.entries.isEmpty)
    }

    @Test("first delta without synthetic returns .streamingBufferOnly")
    func firstDeltaWithoutSyntheticReturnsBufferOnly() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "Hello", isComplete: false))
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .streamingBufferOnly)
        #expect(state.streamingTextByAgent["agent-1"] == "Hello")
    }

    @Test("complete output returns .entriesChanged")
    func completeOutputReturnsEntriesChanged() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        state.streamingTextByAgent["agent-1"] = "Hello"
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: "Hello, world", isComplete: true))
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 3, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .entriesChanged)
    }

    @Test("sequence-dedupe returns .noop")
    func seqDedupeReturnsNoop() {
        var state = TimelineState()
        state.entries = [
            TimelineEntry(id: "x", sequence: 7, eventType: "thinking",
                          text: "t", isComplete: false,
                          senderActorID: "agent-1", timestamp: .now)
        ]
        var acp = Amux_AcpEvent()
        var t1 = Amux_AcpThinking(); t1.text = "t"
        acp.event = .thinking(t1)
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 7, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .noop)
    }

    @Test("thinking appends returns .entriesChanged")
    func thinkingAppendsReturnsEntriesChanged() {
        var state = TimelineState()
        var acp = Amux_AcpEvent()
        var t2 = Amux_AcpThinking(); t2.text = "thought"
        acp.event = .thinking(t2)
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .entriesChanged)
    }

    @Test("statusChange idle with pending text returns .entriesChanged")
    func idleWithTextReturnsEntriesChanged() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        state.streamingTextByAgent["agent-1"] = "partial reply"
        state.streamingTurnIDByAgent["agent-1"] = "turn-x"
        var acp = Amux_AcpEvent()
        acp.event = .statusChange(makeStatusChange(.idle))
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 5, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: "turn-x",
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .entriesChanged)
        #expect(state.streamingAgentSet.isEmpty)
        #expect(state.entries.count == 1)
    }

    @Test("statusChange idle with no pending text returns .streamingBufferOnly")
    func idleWithNoTextReturnsBufferOnly() {
        var state = TimelineState()
        state.streamingAgentSet.insert("agent-1")
        // No text in buffer
        var acp = Amux_AcpEvent()
        acp.event = .statusChange(makeStatusChange(.idle))
        let effect = ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 5, runtimeID: "rt-1",
                          agentBucketKey: "agent-1", timestamp: .now, turnID: nil,
                          acpEvent: acp)),
            to: &state
        )
        #expect(effect == .streamingBufferOnly)
        #expect(state.streamingAgentSet.isEmpty)
    }

    @Test("permissionResolution match returns .entriesChanged")
    func permissionResolutionReturnsEntriesChanged() {
        var state = TimelineState()
        state.entries = [
            TimelineEntry(id: "perm-1", eventType: "permission_request",
                          toolID: "req-1", isComplete: false,
                          senderActorID: "agent-1", timestamp: .now)
        ]
        let effect = ChatTimelineReducer.apply(
            .permissionResolution(PermissionResolutionInput(requestID: "req-1", granted: true)),
            to: &state
        )
        #expect(effect == .entriesChanged)
        #expect(state.entries[0].isComplete == true)
    }

    @Test("permissionResolution no-match returns .noop")
    func permissionResolutionNoMatchReturnsNoop() {
        var state = TimelineState()
        let effect = ChatTimelineReducer.apply(
            .permissionResolution(PermissionResolutionInput(requestID: "req-missing", granted: true)),
            to: &state
        )
        #expect(effect == .noop)
    }
}
