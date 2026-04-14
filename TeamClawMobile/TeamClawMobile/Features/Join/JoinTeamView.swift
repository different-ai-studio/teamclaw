import SwiftUI
import Foundation

// MARK: - InviteTicket

private struct InviteTicket: Decodable {
    let mqttHost: String
    let mqttPort: Int
    let mqttUsername: String
    let mqttPassword: String
    let expiresAt: TimeInterval
}

// MARK: - JoinTeamView

struct JoinTeamView: View {
    let url: URL
    @ObservedObject var pairingManager: PairingManager
    let onComplete: () -> Void

    // Parsed state
    @State private var ticket: InviteTicket?
    @State private var teamID: String = ""
    @State private var parseError: String?

    // UI state
    @State private var validationState: ValidationState = .validating
    @State private var username: String = ""
    @State private var isJoining = false

    enum ValidationState {
        case validating
        case valid
        case expired
        case invalid(String)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                switch validationState {
                case .validating:
                    validatingView

                case .valid:
                    validView

                case .expired:
                    errorView(
                        icon: "clock.badge.xmark",
                        title: "邀请链接已过期",
                        message: "此邀请链接已超过有效期，请联系团队成员重新生成。"
                    )

                case .invalid(let reason):
                    errorView(
                        icon: "link.badge.plus",
                        title: "无效的邀请链接",
                        message: reason
                    )
                }

                Spacer()
            }
            .padding()
            .navigationTitle("加入团队")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        onComplete()
                    }
                }
            }
        }
        .task {
            parseAndValidate()
        }
    }

    // MARK: - Sub-views

    private var validatingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.5)
            Text("正在验证邀请链接…")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var validView: some View {
        VStack(spacing: 20) {
            Image(systemName: "person.badge.plus")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .padding(.top, 16)

            VStack(spacing: 8) {
                Text("加入团队")
                    .font(.title2.bold())
                Text("请输入你的昵称，其他成员将以此识别你。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("昵称")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("请输入你的昵称", text: $username)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.name)
                    .autocorrectionDisabled()
            }

            Button {
                join()
            } label: {
                Group {
                    if isJoining {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text("加入")
                            .fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .disabled(username.trimmingCharacters(in: .whitespaces).isEmpty || isJoining)
        }
    }

    private func errorView(icon: String, title: String, message: String) -> some View {
        VStack(spacing: 20) {
            Image(systemName: icon)
                .font(.system(size: 56))
                .foregroundStyle(.red)
                .padding(.top, 16)

            VStack(spacing: 8) {
                Text(title)
                    .font(.title2.bold())
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button("关闭") {
                onComplete()
            }
            .buttonStyle(.bordered)
        }
    }

    // MARK: - Logic

    private func parseAndValidate() {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            validationState = .invalid("无法解析邀请链接。")
            return
        }

        let queryItems = components.queryItems ?? []
        let ticketStr = queryItems.first(where: { $0.name == "ticket" })?.value
        let team      = queryItems.first(where: { $0.name == "team" })?.value

        guard let ticketStr, let team, !team.isEmpty else {
            validationState = .invalid("邀请链接格式不正确，缺少必要参数。")
            return
        }

        // base64 decode (URL-safe padding)
        var base64 = ticketStr
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }

        guard let data = Data(base64Encoded: base64) else {
            validationState = .invalid("邀请码无法解码，链接可能已损坏。")
            return
        }

        let decoder = JSONDecoder()
        guard let parsed = try? decoder.decode(InviteTicket.self, from: data) else {
            validationState = .invalid("邀请码内容无效，链接可能已损坏。")
            return
        }

        // Check expiry
        let now = Date().timeIntervalSince1970
        if parsed.expiresAt < now {
            validationState = .expired
            return
        }

        ticket = parsed
        teamID = team
        validationState = .valid
    }

    private func join() {
        guard let ticket,
              !username.trimmingCharacters(in: .whitespaces).isEmpty else { return }

        isJoining = true
        let trimmedName = username.trimmingCharacters(in: .whitespaces)
        pairingManager.loginAsLightweightUser(
            teamID: teamID,
            mqttHost: ticket.mqttHost,
            mqttPort: UInt16(ticket.mqttPort),
            mqttUsername: ticket.mqttUsername,
            mqttPassword: ticket.mqttPassword,
            username: trimmedName
        )
        isJoining = false
        onComplete()
    }
}
