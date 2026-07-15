import Testing
@testable import AMUXSharedUI

@Suite("ToolDisplay")
struct ToolDisplayTests {
    @Test("summarizes preferred JSON fields")
    func summarizesPreferredJSONFields() {
        let summary = ToolDisplay.summary(for: #"{"file_path":"/tmp/todo.md","query":"todo"}"#)
        #expect(summary == "file path: /tmp/todo.md · query: todo")
    }

    @Test("falls back to plain description")
    func fallsBackToPlainDescription() {
        let summary = ToolDisplay.summary(for: "Read apps/ios/file.swift")
        #expect(summary == "Read apps/ios/file.swift")
    }

    @Test("ignores empty detail payloads")
    func ignoresEmptyDetailPayloads() {
        #expect(ToolDisplay.summary(for: "{}") == nil)
        #expect(ToolDisplay.summary(for: "null") == nil)
    }
}
