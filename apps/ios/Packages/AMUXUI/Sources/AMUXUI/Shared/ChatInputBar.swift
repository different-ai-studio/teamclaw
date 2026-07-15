import SwiftUI
import AMUXSharedUI

// MARK: - ChatInputBar

public struct ChatInputBar: View {
    @Binding var text: String
    let isDisabled: Bool
    let isStreaming: Bool
    let onSend: () -> Void
    let onCancel: () -> Void

    @State private var isTextInputMode = false
    @FocusState private var isInputFocused: Bool

    public init(text: Binding<String>, isDisabled: Bool, isStreaming: Bool,
                onSend: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self._text = text
        self.isDisabled = isDisabled
        self.isStreaming = isStreaming
        self.onSend = onSend
        self.onCancel = onCancel
    }

    public var body: some View {
        Group {
            if isStreaming {
                streamingStopButton
            } else if isTextInputMode {
                textInputBar
            } else {
                floatingCapsules
            }
        }
        .animation(AMUXAnimation.standard, value: isTextInputMode)
    }

    // MARK: - Floating Capsules

    private var floatingCapsules: some View {
        HStack(spacing: 12) {
            Spacer()

            // Compose button
            Button {
                isTextInputMode = true
                isInputFocused = true
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.title2)
            }
            .accessibilityIdentifier("chatInput.compose")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    // MARK: - Streaming Stop Button

    private var streamingStopButton: some View {
        HStack {
            Spacer()
            Button(action: onCancel) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(.red, in: Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    // MARK: - Text Input Bar

    private var textInputBar: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 4) {
                    TextField(
                        isDisabled ? "Daemon offline" : "Send a prompt\u{2026}",
                        text: $text,
                        axis: .vertical
                    )
                    .font(.body)
                    .lineLimit(1...5)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .padding(.vertical, 10)
                    .disabled(isDisabled)
                    .focused($isInputFocused)
                    .accessibilityIdentifier("chatInput.textField")

                    if showActionButton {
                        actionButton
                            .padding(.trailing, 6)
                            .padding(.bottom, 6)
                    }
                }
                .liquidGlass(in: Capsule(), interactive: true)

                // Dismiss text input mode
                Button {
                    text = ""
                    isTextInputMode = false
                    isInputFocused = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    // MARK: - Action Button

    private var showActionButton: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var actionButton: some View {
        Button {
            onSend()
            isTextInputMode = false
            isInputFocused = false
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.amux.mist)
                .frame(width: 32, height: 32)
                .background(canSend ? Color.amux.cinnabar : Color.amux.slate, in: Circle())
        }
        .disabled(!canSend)
        .accessibilityIdentifier("chatInput.send")
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isDisabled
    }
}
