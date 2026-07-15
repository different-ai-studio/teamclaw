import Testing
@testable import AMUXCore

@Suite("MarkdownBlock.parse")
struct MarkdownBlockTests {

    @Test("returns a single paragraph block for plain text")
    func singleParagraph() {
        let blocks = MarkdownBlock.parse("Hello world")
        #expect(blocks.count == 1)
        if case .paragraph(let text) = blocks[0] {
            #expect(text == "Hello world")
        } else {
            Issue.record("expected paragraph, got \(blocks[0])")
        }
    }

    @Test("splits multi-paragraph input into separate blocks")
    func multiParagraph() {
        let blocks = MarkdownBlock.parse("First.\n\nSecond.")
        #expect(blocks.count == 2)
    }

    @Test("extracts a fenced code block with language and contents")
    func codeBlock() {
        let source = "Look:\n\n```swift\nlet x = 1\n```"
        let blocks = MarkdownBlock.parse(source)
        let codeBlock = blocks.first {
            if case .codeBlock = $0 { return true } else { return false }
        }
        #expect(codeBlock != nil)
        if case .codeBlock(let language, let code) = codeBlock {
            #expect(language == "swift")
            #expect(code.contains("let x = 1"))
        }
    }

    @Test("treats heading line as a heading block")
    func heading() {
        let blocks = MarkdownBlock.parse("# Title\n\nBody.")
        if case .heading(let level, let text) = blocks[0] {
            #expect(level == 1)
            #expect(text == "Title")
        } else {
            Issue.record("expected heading, got \(blocks[0])")
        }
    }

    @Test("collects unordered list items into a single list block")
    func unorderedList() {
        let blocks = MarkdownBlock.parse("- a\n- b\n- c")
        if case .list(let ordered, let items) = blocks[0] {
            #expect(ordered == false)
            #expect(items == ["a", "b", "c"])
        } else {
            Issue.record("expected list, got \(blocks[0])")
        }
    }
}
