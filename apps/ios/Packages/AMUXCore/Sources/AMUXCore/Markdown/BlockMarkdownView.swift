import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct BlockMarkdownView: View {
    let blocks: [MarkdownBlock]
    let baseFont: Font
    let codeFont: Font

    public init(
        source: String,
        baseFont: Font = .system(size: 14),
        codeFont: Font = .system(size: 12, design: .monospaced)
    ) {
        self.blocks = MarkdownBlock.parse(source)
        self.baseFont = baseFont
        self.codeFont = codeFont
    }

    /// Pebble code-block fill, adaptive to color scheme. `#E2DFD9` (Hai
    /// Pebble) in light, `#3A352F` (Sumi stone) in dark. Resolved via a
    /// platform dynamic color since AMUXCore can't reach the AMUXSharedUI
    /// theme without a dependency cycle.
    static let pebbleAdaptive: Color = {
        let light: UInt = 0xE2DFD9
        let dark: UInt = 0x3A352F
        #if canImport(UIKit)
        return Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
        #elseif canImport(AppKit)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let hex = isDark ? dark : light
            return NSColor(
                srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
        #else
        return Color(red: 0xE2 / 255, green: 0xDF / 255, blue: 0xD9 / 255)
        #endif
    }()

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            Text(inlineMarkdown(text))
                .font(baseFont)
                .lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

        case .heading(let level, let text):
            Text(text)
                .font(.system(size: max(13, 22 - CGFloat(level - 1) * 2), weight: .semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)

        case .codeBlock(_, let code):
            Text(code)
                .font(codeFont)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Hai's Pebble token inlined — AMUXCore can't import the
                // higher-level AMUXSharedUI theme module without a cycle. Kept
                // adaptive (Pebble light → Sumi "stone" dark) so the code-block
                // fill doesn't strand the `.primary` text on a light ground in
                // dark mode. Mirror AMUXTheme.pebble if that token changes.
                .background(
                    Self.pebbleAdaptive,
                    in: RoundedRectangle(cornerRadius: 8)
                )
                .textSelection(.enabled)

        case .blockQuote(let text):
            Text(inlineMarkdown(text))
                .font(baseFont)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.4))
                        .frame(width: 3)
                }

        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .top, spacing: 6) {
                        Text(ordered ? "\(idx + 1)." : "•")
                            .font(baseFont)
                            .foregroundStyle(.secondary)
                            .frame(width: 18, alignment: .trailing)
                        Text(inlineMarkdown(item))
                            .font(baseFont)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
