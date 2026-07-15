import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Depth-aware shortcut row.
///
/// - Top-level (depth 0): chevron column (folders only) + icon + label.
///   Link rows reserve the chevron column so labels align vertically with
///   folder labels.
/// - Child rows (depth ≥ 1): plain text indented to start at the parent's
///   label x-coordinate — no icon, no chevron, no trailing glyph.
///
/// All rows render bare — no per-row background, stroke, or card chrome.
struct ShortcutMenuRow: View {
    let node: ShortcutRecord
    let store: ShortcutsStore
    let depth: Int
    @Binding var expandedIDs: Set<String>
    let onSelectLink: (URL, String) -> Void

    private var isExpanded: Bool { expandedIDs.contains(node.id) }
    private var destination: ShortcutPresentation { ShortcutPresentation.destination(for: node) }
    private var isFolder: Bool { node.type == .folder }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: handleTap) {
                rowLabel
            }
            .buttonStyle(ShortcutRowButtonStyle())
            .accessibilityIdentifier("shortcuts.row.\(node.id)")

            if isExpanded, isFolder {
                let children = store.children(parentID: node.id, scope: node.scope)
                if children.isEmpty {
                    HStack(spacing: 0) {
                        Text("Empty")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.amux.slate.opacity(0.7))
                        Spacer(minLength: 6)
                    }
                    .padding(.leading, ShortcutRowMetrics.childIndent(depth: depth + 1))
                    .padding(.trailing, ShortcutRowMetrics.trailingPadding)
                    .padding(.vertical, 8)
                    .transition(.opacity)
                } else {
                    VStack(spacing: 0) {
                        ForEach(children) { child in
                            ShortcutMenuRow(
                                node: child,
                                store: store,
                                depth: depth + 1,
                                expandedIDs: $expandedIDs,
                                onSelectLink: onSelectLink
                            )
                        }
                    }
                    .transition(.opacity)
                }
            }
        }
    }

    @ViewBuilder
    private var rowLabel: some View {
        if depth == 0 {
            topLevelRow
        } else {
            childRow
        }
    }

    private var topLevelRow: some View {
        HStack(spacing: ShortcutRowMetrics.chevronToIconSpacing) {
            chevronSlot
                .frame(width: ShortcutRowMetrics.chevronWidth)

            iconView
                .frame(width: ShortcutRowMetrics.iconWidth)

            Text(node.label)
                .font(.system(size: 15))
                .foregroundStyle(rowDisabled ? Color.amux.slate : Color.amux.onyx)
                .lineLimit(1)

            Spacer(minLength: 6)
        }
        .padding(.leading, ShortcutRowMetrics.leadingPadding)
        .padding(.trailing, ShortcutRowMetrics.trailingPadding)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    private var childRow: some View {
        HStack(spacing: 0) {
            Text(node.label)
                .font(.system(size: 14.5))
                .foregroundStyle(rowDisabled ? Color.amux.slate : Color.amux.onyx)
                .lineLimit(1)
            Spacer(minLength: 6)
        }
        .padding(.leading, ShortcutRowMetrics.childIndent(depth: depth))
        .padding(.trailing, ShortcutRowMetrics.trailingPadding)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var chevronSlot: some View {
        if isFolder {
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.amux.slate)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
        } else {
            Color.clear
        }
    }

    @ViewBuilder
    private var iconView: some View {
        let kind = IconKind.detect(node.icon)
        switch kind {
        case .emoji(let s):
            Text(s)
                .font(.system(size: 17))
        case .symbol(let name):
            Image(systemName: name)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(iconColor)
        case .none:
            Image(systemName: defaultSymbol)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(iconColor)
        }
    }

    private var rowDisabled: Bool {
        if case .disabled = destination { return true }
        return false
    }

    private var iconColor: Color {
        switch node.type {
        case .folder: return Color.amux.basalt
        case .link:   return Color.amux.basalt
        case .native: return Color.amux.slate
        }
    }

    private var defaultSymbol: String {
        switch node.type {
        case .folder: return "folder"
        case .link:   return "link"
        case .native: return "app"
        }
    }

    private func handleTap() {
        switch destination {
        case .folder:
            withAnimation(.easeInOut(duration: 0.22)) {
                if expandedIDs.contains(node.id) {
                    expandedIDs.remove(node.id)
                } else {
                    expandedIDs.insert(node.id)
                }
            }
        case .web(let url):
            onSelectLink(url, node.label)
        case .disabled:
            break
        }
    }
}

/// Shared layout constants so children can align with their parent's label
/// across recursive renders.
enum ShortcutRowMetrics {
    static let leadingPadding: CGFloat = 20
    static let trailingPadding: CGFloat = 20
    static let chevronWidth: CGFloat = 16
    static let chevronToIconSpacing: CGFloat = 8
    static let iconWidth: CGFloat = 22

    /// Where labels sit, in points from the row's leading edge. Children
    /// indent to this so their text starts at their parent's label column.
    static var labelStartX: CGFloat {
        leadingPadding + chevronWidth + chevronToIconSpacing + iconWidth + chevronToIconSpacing
    }

    /// Indent for a child at the given depth. depth=1 aligns with the
    /// top-level label column; each additional level adds a small extra
    /// indent so deep nesting is still legible.
    static func childIndent(depth: Int) -> CGFloat {
        let extra = max(0, depth - 1) * 14
        return labelStartX + CGFloat(extra)
    }
}

private struct ShortcutRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.amux.onyx.opacity(0.04) : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

enum IconKind {
    case emoji(String)
    case symbol(String)
    case none

    static func detect(_ value: String?) -> IconKind {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return .none
        }
        let symbolAllowed = CharacterSet.alphanumerics
            .union(CharacterSet(charactersIn: ".-_"))
        if raw.unicodeScalars.allSatisfy({ symbolAllowed.contains($0) }) {
            return .symbol(raw)
        }
        return .emoji(raw)
    }
}
