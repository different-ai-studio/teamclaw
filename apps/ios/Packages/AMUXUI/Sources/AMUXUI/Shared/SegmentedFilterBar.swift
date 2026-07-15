import SwiftUI
import AMUXSharedUI

#if os(iOS)

/// Pill-style segmented filter used at the top of the Ideas and Actors
/// lists. Source-of-truth: `ideas-board.jsx` / `actors-list.jsx` in the
/// AMUX iOS handoff.
///
/// Active segment fills Onyx with white text + mono count; inactive
/// segments stay transparent on a Pebble-tinted track, Basalt text +
/// Slate count. Counts are optional so the bar reads as "All / Mine /
/// Open / Done" until totals are computed.
struct SegmentedFilterBar<Tag: Hashable>: View {
    struct Segment: Identifiable {
        let tag: Tag
        let title: String
        let count: Int?

        var id: Tag { tag }

        init(tag: Tag, title: String, count: Int? = nil) {
            self.tag = tag
            self.title = title
            self.count = count
        }
    }

    let segments: [Segment]
    @Binding var selection: Tag

    var body: some View {
        HStack(spacing: 4) {
            ForEach(segments) { segment in
                pill(for: segment)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .fill(Color.amux.pebble.opacity(0.55))
        )
    }

    @ViewBuilder
    private func pill(for segment: Segment) -> some View {
        let isActive = segment.tag == selection
        Button {
            selection = segment.tag
        } label: {
            HStack(spacing: 5) {
                Text(segment.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(isActive ? Color.white : Color.amux.basalt)
                    .lineLimit(1)
                    .layoutPriority(1)
                if let count = segment.count {
                    Text("·")
                        .font(.system(size: 13))
                        .foregroundStyle(isActive ? Color.white.opacity(0.65) : Color.amux.slate)
                    Text("\(count)")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(isActive ? Color.white.opacity(0.7) : Color.amux.slate)
                        .monospacedDigit()
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.9)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                Capsule().fill(isActive ? Color.amux.onyx : Color.clear)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

#endif
