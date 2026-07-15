import Foundation
import Markdown

public enum MarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case codeBlock(language: String?, code: String)
    case blockQuote(String)
    case list(ordered: Bool, items: [String])

    public static func parse(_ source: String) -> [MarkdownBlock] {
        let document = Document(parsing: source)
        var blocks: [MarkdownBlock] = []
        for child in document.children {
            if let block = convert(child) {
                blocks.append(block)
            }
        }
        return blocks
    }

    private static func convert(_ markup: any Markup) -> MarkdownBlock? {
        switch markup {
        case let p as Paragraph:
            return .paragraph(plainText(p))
        case let h as Heading:
            return .heading(level: h.level, text: plainText(h))
        case let cb as CodeBlock:
            return .codeBlock(language: cb.language, code: cb.code)
        case let bq as BlockQuote:
            let text = bq.children.map { plainText($0) }.joined(separator: "\n\n")
            return .blockQuote(text)
        case let ul as UnorderedList:
            return .list(ordered: false, items: ul.listItems.map { plainText($0) })
        case let ol as OrderedList:
            return .list(ordered: true, items: ol.listItems.map { plainText($0) })
        default:
            return nil
        }
    }

    private static func plainText(_ markup: any Markup) -> String {
        var walker = TextCollector()
        walker.visit(markup)
        return walker.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private struct TextCollector: MarkupWalker {
    var text: String = ""
    mutating func visitText(_ text: Text) { self.text += text.string }
    mutating func visitInlineCode(_ inlineCode: InlineCode) { self.text += inlineCode.code }
    mutating func visitSoftBreak(_ softBreak: SoftBreak) { self.text += " " }
    mutating func visitLineBreak(_ lineBreak: LineBreak) { self.text += "\n" }
}
