import SwiftUI
import Foundation

// MARK: - InviteView

struct InviteView: View {
    @ObservedObject var pairingManager: PairingManager
    @State private var inviteLink: String?
    @State private var generateError: String?
    @State private var isCopied = false

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Text("邀请成员加入团队")
                        .font(.headline)
                    Text("生成一个有效期 24 小时的邀请链接，发送给想要加入团队的成员。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            if let link = inviteLink {
                Section("邀请链接") {
                    Text(link)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .truncationMode(.middle)

                    HStack(spacing: 12) {
                        Button {
                            UIPasteboard.general.string = link
                            isCopied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                isCopied = false
                            }
                        } label: {
                            Label(isCopied ? "已复制" : "复制链接", systemImage: isCopied ? "checkmark" : "doc.on.doc")
                        }
                        .buttonStyle(.bordered)

                        ShareLink(item: link) {
                            Label("分享", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            } else if let error = generateError {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    generateLink()
                } label: {
                    Label("生成新链接", systemImage: "link.badge.plus")
                }
            }
        }
        .navigationTitle("邀请成员")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            generateLink()
        }
    }

    // MARK: - Logic

    private func generateLink() {
        guard let creds = pairingManager.credentials else {
            generateError = "未找到团队凭证，请先配对或加入团队。"
            return
        }

        generateError = nil

        let expiresAt = Date().timeIntervalSince1970 + 86400  // 24 hours
        let ticketDict: [String: Any] = [
            "mqttHost":     creds.mqttHost,
            "mqttPort":     Int(creds.mqttPort),
            "mqttUsername": creds.mqttUsername,
            "mqttPassword": creds.mqttPassword,
            "expiresAt":    expiresAt
        ]

        guard let ticketData = try? JSONSerialization.data(withJSONObject: ticketDict) else {
            generateError = "无法序列化邀请票据。"
            return
        }

        let base64Ticket = ticketData.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        var components = URLComponents()
        components.scheme = "teamclaw"
        components.host = "join"
        components.queryItems = [
            URLQueryItem(name: "ticket", value: base64Ticket),
            URLQueryItem(name: "team",   value: creds.teamID)
        ]

        if let link = components.url?.absoluteString {
            inviteLink = link
        } else {
            generateError = "无法生成邀请链接。"
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        InviteView(pairingManager: PairingManager())
    }
}
