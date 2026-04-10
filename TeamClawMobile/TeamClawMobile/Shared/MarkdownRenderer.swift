import SwiftUI
import Markdown

struct MarkdownRenderer: View {
    let content: String

    var body: some View {
        Text(attributedContent)
            .textSelection(.enabled)
    }

    private var attributedContent: AttributedString {
        do {
            return try AttributedString(markdown: content, options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            ))
        } catch {
            return AttributedString(content)
        }
    }
}

#Preview {
    ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            MarkdownRenderer(content: """
            # Heading 1
            ## Heading 2

            This is some **bold text** and *italic text*.

            - Item 1
            - Item 2
            - Item 3

            ```swift
            let message = "Hello, World!"
            ```

            > This is a blockquote
            > with multiple lines
            """)
                .padding()
        }
    }
}
