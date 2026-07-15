import SwiftUI
import AMUXCore

/// Inline autocomplete popup for ACP slash commands. Rendered by the
/// composer whenever the user's in-progress text matches `/<prefix>`
/// and at least one known command starts with that prefix.
///
/// Stateless: the parent owns `candidates` and the `onTap` handler that
/// inserts `/<name> ` into the composer.
public struct SlashCommandsPopup: View {
    let candidates: [SlashCommand]
    let onTap: (SlashCommand) -> Void

    public init(candidates: [SlashCommand], onTap: @escaping (SlashCommand) -> Void) {
        self.candidates = candidates
        self.onTap = onTap
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(candidates) { cmd in
                    Button {
                        onTap(cmd)
                    } label: {
                        SlashCommandRow(cmd: cmd)
                    }
                    .buttonStyle(HaiRowPressStyle())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(Text(accessibilityLabel(for: cmd)))
                    .accessibilityHint(Text("Inserts this command into the message"))

                    if cmd.id != candidates.last?.id {
                        Rectangle()
                            .fill(Color.amux.onyx.opacity(0.08))
                            .frame(height: 0.5)
                            .padding(.leading, 12)
                    }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 200)
        .background(Color.amux.pebble, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .strokeBorder(Color.amux.onyx.opacity(0.08), lineWidth: 0.5)
        )
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private func accessibilityLabel(for cmd: SlashCommand) -> String {
        var label = "slash \(cmd.name). \(cmd.description)"
        if !cmd.inputHint.isEmpty {
            label += ". argument \(cmd.inputHint)"
        }
        return label
    }
}

private struct SlashCommandRow: View {
    let cmd: SlashCommand

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("/\(cmd.name)")
                    .font(.system(.body, design: .monospaced).weight(.semibold))
                    .foregroundStyle(Color.amux.onyx)
                Spacer(minLength: 8)
                if !cmd.inputHint.isEmpty {
                    Text(cmd.inputHint.uppercased())
                        .font(.system(size: 10, design: .monospaced))
                        .tracking(2.8)
                        .foregroundStyle(Color.amux.slate.opacity(0.7))
                        .lineLimit(1)
                }
            }
            if !cmd.description.isEmpty {
                Text(cmd.description)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.amux.basalt)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 36)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
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
    SlashCommandsPopup(
        candidates: [
            SlashCommand(name: "clear", description: "Clear conversation history", inputHint: ""),
            SlashCommand(name: "compact", description: "Compact the context window", inputHint: ""),
            SlashCommand(name: "rename", description: "Rename this session", inputHint: "new name"),
            SlashCommand(name: "plan-ceo-review", description: "CEO/founder-mode plan review of the current session", inputHint: ""),
        ],
        onTap: { _ in }
    )
    .padding()
    .background(Color.amux.mist)
}
