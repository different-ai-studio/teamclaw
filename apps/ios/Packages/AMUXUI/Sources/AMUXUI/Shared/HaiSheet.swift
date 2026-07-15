import SwiftUI
import AMUXSharedUI

/// Small uppercase section header used to label a paper card on a Hai-style
/// sheet (pebble background, paper cards). See `IdeaSheet.swift` for the
/// canonical example.
struct HaiSectionLabel: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
            .padding(.horizontal, 24)
    }
}

/// Reusable Hai sheet row body — left label, right value, optional chevron.
/// Plain layout (no surrounding card) so callers can stack multiple in one
/// paper card with hairline dividers.
struct HaiSheetRow: View {
    let label: String
    let value: String?
    let valueIsMonospaced: Bool
    let valueIsMuted: Bool
    let showsChevron: Bool

    init(label: String,
         value: String? = nil,
         valueIsMonospaced: Bool = false,
         valueIsMuted: Bool = false,
         showsChevron: Bool = false) {
        self.label = label
        self.value = value
        self.valueIsMonospaced = valueIsMonospaced
        self.valueIsMuted = valueIsMuted
        self.showsChevron = showsChevron
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.amux.onyx)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(.system(size: 14, design: valueIsMonospaced ? .monospaced : .default))
                    .foregroundStyle(valueIsMuted ? Color.amux.basalt.opacity(0.6) : Color.amux.basalt)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.amux.slate)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
    }
}

/// Wraps content in the standard Hai paper card (radius 14, paper fill,
/// horizontal inset matching the section label).
struct HaiPaperCard<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.amux.paper)
            )
            .padding(.horizontal, 16)
    }
}
