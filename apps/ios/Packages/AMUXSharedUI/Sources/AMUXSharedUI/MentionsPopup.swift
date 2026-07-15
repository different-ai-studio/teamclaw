import SwiftUI
import AMUXCore

/// Inline autocomplete card for `@`-mentions. Shows session humans and
/// agents in a single visually-grouped list. Tapping a row passes the
/// `MentionTarget` back to the parent which decides what to do with it
/// (members → inline `@name` token in the body, agents → add a removable
/// chip above the composer).
public struct MentionsPopup: View {
    let candidates: [MentionTarget]
    let onTap: (MentionTarget) -> Void

    public init(candidates: [MentionTarget],
                onTap: @escaping (MentionTarget) -> Void) {
        self.candidates = candidates
        self.onTap = onTap
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(candidates) { target in
                Button {
                    onTap(target)
                } label: {
                    MentionRow(target: target)
                }
                .buttonStyle(HaiRowPressStyle())
                .accessibilityLabel(Text(target.kind == .agent
                    ? "agent \(target.displayName)"
                    : "member \(target.displayName)"))

                if target.id != candidates.last?.id {
                    Rectangle()
                        .fill(Color.amux.onyx.opacity(0.08))
                        .frame(height: 0.5)
                        .padding(.leading, 28)
                }
            }
        }
        .background(Color.amux.pebble, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .strokeBorder(Color.amux.onyx.opacity(0.08), lineWidth: 0.5)
        )
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

private struct MentionRow: View {
    let target: MentionTarget

    var body: some View {
        HStack(spacing: 10) {
            glyph
                .frame(width: 16, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(target.displayName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                if let subtitle = target.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.amux.slate)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 36)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var glyph: some View {
        switch target.kind {
        case .member:
            Text("@")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Color.amux.slate)
        case .agent:
            Circle()
                .fill(Color.amux.slate)
                .frame(width: 6, height: 6)
        }
    }
}

private struct HaiRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                Color.amux.onyx
                    .opacity(configuration.isPressed ? 0.04 : 0)
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#Preview {
    VStack {
        Spacer()
        MentionsPopup(
            candidates: [
                MentionTarget(id: "1", displayName: "matt", subtitle: "Member", kind: .member),
                MentionTarget(id: "2", displayName: "macmini-simulator", subtitle: "Member", kind: .member),
                MentionTarget(id: "3", displayName: "mini", subtitle: "Claude · idle", kind: .agent),
                MentionTarget(id: "4", displayName: "swarm-1", subtitle: "OpenCode · running", kind: .agent),
            ],
            onTap: { _ in }
        )
        .padding(.horizontal, 16)
        Spacer()
    }
    .background(Color.amux.mist)
}
