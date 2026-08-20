import SwiftUI
import AMUXCore

/// Renders the `AcpToolCallDiff` an edit tool carried: the file path plus a
/// line diff. Long diffs are truncated for the feed — the point on mobile is
/// reviewing what the agent changed, not scrolling a 2,000-line patch.
public struct ToolCallDiffView: View {
    private let path: String
    private let lines: [LineDiff.Line]
    private let added: Int
    private let removed: Int

    /// Rows rendered before the "… N more lines" cutoff.
    private static let maxVisibleLines = 200

    public init(path: String, oldText: String?, newText: String) {
        self.path = path
        let computed = LineDiff.diff(old: oldText ?? "", new: newText)
        self.lines = computed
        let stats = LineDiff.stats(computed)
        self.added = stats.added
        self.removed = stats.removed
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(path.isEmpty ? "diff" : path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                Text("+\(added)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.amux.sage)
                Text("−\(removed)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.amux.cinnabarDeep)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(Self.maxVisibleLines).enumerated()), id: \.offset) { _, line in
                        diffRow(line)
                    }
                    if lines.count > Self.maxVisibleLines {
                        Text("… \(lines.count - Self.maxVisibleLines) more lines")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Color.amux.slate)
                            .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func diffRow(_ line: LineDiff.Line) -> some View {
        HStack(spacing: 0) {
            Text(marker(for: line.kind))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(markerColor(for: line.kind))
                .frame(width: 12, alignment: .leading)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(textColor(for: line.kind))
                .textSelection(.enabled)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background(for: line.kind))
    }

    private func marker(for kind: LineDiff.Kind) -> String {
        switch kind {
        case .context: return " "
        case .insert: return "+"
        case .delete: return "−"
        }
    }

    private func markerColor(for kind: LineDiff.Kind) -> Color {
        switch kind {
        case .context: return Color.amux.slate
        case .insert: return Color.amux.sage
        case .delete: return Color.amux.cinnabarDeep
        }
    }

    private func textColor(for kind: LineDiff.Kind) -> Color {
        switch kind {
        case .context: return Color.amux.basalt
        case .insert: return Color.amux.onyx
        case .delete: return Color.amux.basalt
        }
    }

    private func background(for kind: LineDiff.Kind) -> Color {
        switch kind {
        case .context: return .clear
        case .insert: return Color.amux.sage.opacity(0.12)
        case .delete: return Color.amux.cinnabarDeep.opacity(0.10)
        }
    }
}
