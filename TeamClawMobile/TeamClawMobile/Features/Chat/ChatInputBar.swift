import PhotosUI
import SwiftUI

struct ChatInputBar: View {
    @Binding var text: String
    let isDisabled: Bool
    let onSend: () -> Void
    let onModelTap: () -> Void
    let onImageSelected: (UIImage) -> Void

    @State private var photoPickerItem: PhotosPickerItem?

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            VStack(spacing: 8) {
                // Tool bar row
                HStack(spacing: 16) {
                    Button {
                        onModelTap()
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.title3)
                            .foregroundStyle(isDisabled ? .secondary : .primary)
                    }
                    .disabled(isDisabled)

                    PhotosPicker(
                        selection: $photoPickerItem,
                        matching: .images
                    ) {
                        Image(systemName: "paperclip")
                            .font(.title3)
                            .foregroundStyle(isDisabled ? .secondary : .primary)
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

                    Spacer()
                }
                .padding(.horizontal, 16)

                // Input row
                HStack(spacing: 8) {
                    TextField(
                        isDisabled ? "桌面端离线" : "输入消息...",
                        text: $text,
                        axis: .vertical
                    )
                    .lineLimit(1...5)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .disabled(isDisabled)

                    Button {
                        onSend()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(canSend ? .blue : .secondary)
                    }
                    .disabled(!canSend)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            .padding(.top, 8)
            .background(.ultraThinMaterial)
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isDisabled
    }
}
