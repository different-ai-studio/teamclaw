import SwiftUI

// MARK: - UsernameSettingView

struct UsernameSettingView: View {
    @ObservedObject var pairingManager: PairingManager
    @State private var editedName: String = ""
    @State private var isSaved = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section("昵称") {
                TextField("请输入昵称", text: $editedName)
                    .textContentType(.name)
                    .autocorrectionDisabled()
            } footer: {
                Text("其他团队成员将看到此昵称。")
            }
        }
        .navigationTitle("个人资料")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    save()
                }
                .disabled(editedName.trimmingCharacters(in: .whitespaces).isEmpty)
                .fontWeight(isSaved ? .regular : .semibold)
                .overlay(alignment: .trailing) {
                    if isSaved {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.green)
                            .font(.caption)
                            .offset(x: 16)
                    }
                }
            }
        }
        .onAppear {
            editedName = pairingManager.username
        }
    }

    // MARK: - Logic

    private func save() {
        let trimmed = editedName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        pairingManager.updateUsername(trimmed)
        isSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            isSaved = false
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        UsernameSettingView(pairingManager: PairingManager())
    }
}
