import PhotosUI
import SwiftUI

struct ChatInputBar: View {
    @Binding var text: String
    let isDisabled: Bool
    let isStreaming: Bool
    let onSend: () -> Void
    let onCancel: () -> Void
    let onImageSelected: (UIImage) -> Void

    @State private var photoPickerItem: PhotosPickerItem?

    var body: some View {
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

                if showActionButton {
                    actionButton
                        .padding(.trailing, 4)
                        .padding(.bottom, 4)
                }
            }
            .background(Color(.systemGray6), in: Capsule())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

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
            Button(action: onSend) {
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
