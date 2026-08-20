import Testing
import Foundation
@testable import AMUXCore

// MARK: - LineDiff

@Suite("LineDiff")
struct LineDiffTests {
    @Test("unchanged text is all context")
    func unchangedIsContext() {
        let lines = LineDiff.diff(old: "a\nb\nc", new: "a\nb\nc")
        #expect(lines.allSatisfy { $0.kind == .context })
        #expect(lines.count == 3)
    }

    @Test("a replaced line reads as delete + insert around context")
    func replacedLine() {
        let lines = LineDiff.diff(old: "a\nb\nc", new: "a\nX\nc")
        #expect(lines == [
            LineDiff.Line(kind: .context, text: "a"),
            LineDiff.Line(kind: .delete, text: "b"),
            LineDiff.Line(kind: .insert, text: "X"),
            LineDiff.Line(kind: .context, text: "c"),
        ])
        let stats = LineDiff.stats(lines)
        #expect(stats.added == 1)
        #expect(stats.removed == 1)
    }

    @Test("empty old side is a pure insertion (new file)")
    func pureInsertion() {
        let lines = LineDiff.diff(old: "", new: "a\nb")
        #expect(lines == [
            LineDiff.Line(kind: .insert, text: "a"),
            LineDiff.Line(kind: .insert, text: "b"),
        ])
    }

    @Test("trailing newline does not produce a phantom empty line")
    func trailingNewline() {
        let lines = LineDiff.diff(old: "a\n", new: "a\n")
        #expect(lines.count == 1)
    }

    @Test("inputs past the cap degrade to delete-all/insert-all instead of hanging")
    func capDegrades() {
        let old = Array(repeating: "x", count: 500).joined(separator: "\n")
        let new = Array(repeating: "y", count: 500).joined(separator: "\n")
        let lines = LineDiff.diff(old: old, new: new, maxLines: 400)
        #expect(lines.count == 1000)
        #expect(lines.prefix(500).allSatisfy { $0.kind == .delete })
        #expect(lines.suffix(500).allSatisfy { $0.kind == .insert })
    }
}

// MARK: - Reducer diff extraction

@Suite("ChatTimelineReducer — tool-call diff content")
struct ReducerToolDiffTests {
    private func makeToolUse(toolID: String, diff: Amux_AcpToolCallDiff?) -> Amux_AcpEvent {
        var toolUse = Amux_AcpToolUse()
        toolUse.toolID = toolID
        toolUse.toolName = "Edit"
        if let diff {
            var content = Amux_AcpToolCallContent()
            content.payload = .diff(diff)
            toolUse.content = [content]
        }
        var acp = Amux_AcpEvent()
        acp.event = .toolUse(toolUse)
        return acp
    }

    private func makeDiff(path: String, old: String?, new: String) -> Amux_AcpToolCallDiff {
        var diff = Amux_AcpToolCallDiff()
        diff.path = path
        if let old { diff.oldText = old }
        diff.newText = new
        return diff
    }

    @Test("ToolUse carrying a diff lands it on the tool_use entry")
    func toolUseDiffLands() {
        var state = TimelineState()
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: makeToolUse(toolID: "t1",
                                                diff: makeDiff(path: "src/a.swift", old: "old", new: "new")))),
            to: &state
        )
        #expect(state.entries.count == 1)
        #expect(state.entries[0].diffPath == "src/a.swift")
        #expect(state.entries[0].diffOldText == "old")
        #expect(state.entries[0].diffNewText == "new")
    }

    @Test("ToolResult diff fills in when the ToolUse had none")
    func toolResultDiffFillsIn() {
        var state = TimelineState()
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 1, agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: makeToolUse(toolID: "t1", diff: nil))),
            to: &state
        )

        var toolResult = Amux_AcpToolResult()
        toolResult.toolID = "t1"
        toolResult.success = true
        var content = Amux_AcpToolCallContent()
        content.payload = .diff(makeDiff(path: "src/b.swift", old: nil, new: "created"))
        toolResult.content = [content]
        var acp = Amux_AcpEvent()
        acp.event = .toolResult(toolResult)
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 2, agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: acp)),
            to: &state
        )

        #expect(state.entries.count == 1)
        #expect(state.entries[0].diffPath == "src/b.swift")
        #expect(state.entries[0].diffOldText == nil, "unset old_text means file creation, not empty file")
        #expect(state.entries[0].diffNewText == "created")
        #expect(state.entries[0].isComplete)
    }
}

// MARK: - Permission replay dedupe

@Suite("ChatTimelineReducer — permission request replay dedupe")
struct ReducerPermissionDedupeTests {
    private func makePermission(requestID: String) -> Amux_AcpEvent {
        var pr = Amux_AcpPermissionRequest()
        pr.requestID = requestID
        pr.toolName = "WebSearch"
        pr.description_p = "search"
        var acp = Amux_AcpEvent()
        acp.event = .permissionRequest(pr)
        return acp
    }

    @Test("a replayed request with a renumbered sequence does not duplicate the card")
    func replayDoesNotDuplicate() {
        var state = TimelineState()
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 5, agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: makePermission(requestID: "perm-1"))),
            to: &state
        )
        // Same request replayed after a daemon restart renumbered sequences.
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: 42, agentBucketKey: "agent-1", timestamp: .now,
                          acpEvent: makePermission(requestID: "perm-1"))),
            to: &state
        )
        #expect(state.entries.filter { $0.eventType == "permission_request" }.count == 1)
    }
}
