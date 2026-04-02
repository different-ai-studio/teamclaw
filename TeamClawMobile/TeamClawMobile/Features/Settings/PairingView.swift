import SwiftUI

// MARK: - PairingView

struct PairingView: View {
    @ObservedObject var pairingManager: PairingManager

    @State private var code = ""
    @FocusState private var isCodeFocused: Bool

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            // Icon
            Image(systemName: "link.badge.plus")
                .font(.system(size: 64))
                .foregroundStyle(.blue)

            // Title and subtitle
            VStack(spacing: 8) {
                Text("连接桌面端")
                    .font(.title.bold())

                Text("在桌面端设置中生成配对码，然后在下方输入")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            // Code input
            VStack(spacing: 12) {
                TextField("000000", text: $code)
                    .font(.system(.title, design: .monospaced).bold())
                    .multilineTextAlignment(.center)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($isCodeFocused)
                    .onChange(of: code) { _, newValue in
                        // Limit to 6 digits
                        let filtered = newValue.filter(\.isNumber)
                        if filtered.count > 6 {
                            code = String(filtered.prefix(6))
                        } else if filtered != newValue {
                            code = filtered
                        }
                    }
                    .padding(.horizontal, 40)

                Divider()
                    .padding(.horizontal, 40)

                // Error text
                if let error = pairingManager.pairingError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            // Pair button
            Button {
                pairingManager.pair(with: code)
            } label: {
                Text("配对")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(code.count != 6)
            .padding(.horizontal, 40)

            Spacer()
        }
        .onAppear {
            isCodeFocused = true
        }
    }
}

// MARK: - Preview

#Preview {
    PairingView(pairingManager: PairingManager())
}
