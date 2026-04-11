import PhotosUI
import SwiftUI

// MARK: - ChatInputBar

struct ChatInputBar: View {
    @Binding var text: String
    let isDisabled: Bool
    let isStreaming: Bool
    let session: Session
    let onSend: () -> Void
    let onCancel: () -> Void
    let onImageSelected: (UIImage) -> Void
    let onTogglePin: () -> Void
    let onArchive: () -> Void
    let onShowMenu: () -> Void

    @State private var isTextInputMode = false
    @State private var showArchiveConfirmation = false
    @FocusState private var isInputFocused: Bool
    @State private var photoPickerItem: PhotosPickerItem?

    var body: some View {
        Group {
            if isTextInputMode || isStreaming {
                textInputBar
            } else {
                floatingCapsules
            }
        }
        .animation(.spring(duration: 0.25), value: isTextInputMode)
        .confirmationDialog("确定要归档这个会话吗？", isPresented: $showArchiveConfirmation, titleVisibility: .visible) {
            Button("归档", role: .destructive, action: onArchive)
            Button("取消", role: .cancel) {}
        }
        .onChange(of: photoPickerItem) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    onImageSelected(image)
                }
                photoPickerItem = nil
            }
        }
    }

    // MARK: - Floating Capsules

    private var floatingCapsules: some View {
        HStack(spacing: 12) {
            // Left group: Pin + Archive
            HStack(spacing: 0) {
                Button(action: onTogglePin) {
                    Image(systemName: session.isPinned ? "pin.slash.fill" : "pin.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                }

                Button { showArchiveConfirmation = true } label: {
                    Image(systemName: "archivebox.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                }
            }
            .liquidGlass(in: Capsule())

            Spacer()

            // Center: Voice input
            Button {
                // TODO: voice input
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.primary)
                    .frame(width: 52, height: 52)
            }
            .liquidGlass(in: Circle())

            Spacer()

            // Right group: Menu + Text input
            HStack(spacing: 0) {
                Button(action: onShowMenu) {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                }

                Button {
                    isTextInputMode = true
                    isInputFocused = true
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 17))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                }
            }
            .liquidGlass(in: Capsule())
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    // MARK: - Text Input Bar

    private var textInputBar: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(
                    selection: $photoPickerItem,
                    matching: .images
                ) {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 34, height: 34)
                        .liquidGlass(in: Circle())
                }
                .disabled(isDisabled)

                HStack(alignment: .bottom, spacing: 4) {
                    TextField(
                        isDisabled ? "桌面端离线" : "输入消息...",
                        text: $text,
                        axis: .vertical
                    )
                    .lineLimit(1...5)
                    .padding(.leading, 12)
                    .padding(.trailing, 4)
                    .padding(.vertical, 8)
                    .disabled(isDisabled || isStreaming)
                    .focused($isInputFocused)

                    if showActionButton {
                        actionButton
                            .padding(.trailing, 4)
                            .padding(.bottom, 4)
                    }
                }
                .background(Color(.systemGray6), in: Capsule())

                // Dismiss text input mode
                if !isStreaming {
                    Button {
                        text = ""
                        isTextInputMode = false
                        isInputFocused = false
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .medium))
                            .frame(width: 34, height: 34)
                            .liquidGlass(in: Circle())
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    // MARK: - Action Button

    private var showActionButton: Bool {
        isStreaming || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var actionButton: some View {
        if isStreaming {
            Button(action: onCancel) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.red, in: Circle())
            }
        } else {
            Button {
                onSend()
                isTextInputMode = false
                isInputFocused = false
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(canSend ? Color.blue : Color.secondary, in: Circle())
            }
            .disabled(!canSend)
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isDisabled
    }
}
