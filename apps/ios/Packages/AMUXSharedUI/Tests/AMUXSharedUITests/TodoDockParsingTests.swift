import Testing
@testable import AMUXSharedUI
@testable import AMUXCore

@Suite("parseTodoText")
struct TodoDockParsingTests {
    @Test("empty text → empty array")
    func emptyText() {
        #expect(parseTodoText("") == [])
    }

    @Test("[done] prefix → .completed")
    func donePrefix() {
        let items = parseTodoText("[done] First item")
        #expect(items.count == 1)
        #expect(items[0].status == .completed)
        #expect(items[0].content == "First item")
    }

    @Test("[wip] prefix → .inProgress")
    func wipPrefix() {
        let items = parseTodoText("[wip] Second item")
        #expect(items[0].status == .inProgress)
        #expect(items[0].content == "Second item")
    }

    @Test("[todo] prefix → .pending")
    func todoPrefix() {
        let items = parseTodoText("[todo] Third item")
        #expect(items[0].status == .pending)
        #expect(items[0].content == "Third item")
    }

    @Test("[cancelled] prefix → .cancelled")
    func cancelledPrefix() {
        let items = parseTodoText("[cancelled] Fourth item")
        #expect(items[0].status == .cancelled)
        #expect(items[0].content == "Fourth item")
    }

    @Test("unknown prefix → .pending with raw line as content")
    func unknownPrefix() {
        let items = parseTodoText("just text no prefix")
        #expect(items.count == 1)
        #expect(items[0].status == .pending)
        #expect(items[0].content == "just text no prefix")
    }

    @Test("multiline input → one item per line, status preserved")
    func multilineMixed() {
        let text = """
        [done] One
        [wip] Two
        [todo] Three
        [cancelled] Four
        """
        let items = parseTodoText(text)
        #expect(items.count == 4)
        #expect(items.map(\.status) == [.completed, .inProgress, .pending, .cancelled])
        #expect(items.map(\.content) == ["One", "Two", "Three", "Four"])
    }

    @Test("trailing whitespace on content is trimmed")
    func trailingWhitespaceTrimmed() {
        let items = parseTodoText("[done] Trimmed   ")
        #expect(items[0].content == "Trimmed")
    }

    @Test("blank lines are skipped")
    func blankLinesSkipped() {
        let text = "[done] One\n\n[wip] Two\n"
        let items = parseTodoText(text)
        #expect(items.count == 2)
    }
}
