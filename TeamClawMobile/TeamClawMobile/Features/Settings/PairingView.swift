import SwiftUI

// MARK: - PairingView

struct PairingView: View {
    @ObservedObject var pairingManager: PairingManager

    @State private var code = ""
    @State private var mqttHost: String = UserDefaults.standard.string(forKey: "teamclaw_pairing_broker_host") ?? ""
    @State private var mqttPort: String = {
        let saved = UserDefaults.standard.integer(forKey: "teamclaw_pairing_broker_port")
        return saved > 0 ? String(saved) : "8883"
    }()
    @State private var mqttUsername: String = UserDefaults.standard.string(forKey: "teamclaw_pairing_broker_username") ?? ""
    @State private var mqttPassword: String = UserDefaults.standard.string(forKey: "teamclaw_pairing_broker_password") ?? ""
    @FocusState private var focusedField: Field?

    private enum Field {
        case host, port, username, password, code
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer().frame(height: 20)

                // Icon
                Image(systemName: "link.badge.plus")
                    .font(.system(size: 56))
                    .foregroundStyle(.blue)

                // Title and subtitle
                VStack(spacing: 8) {
                    Text("连接桌面端")
                        .font(.title.bold())

                    Text("输入 MQTT 服务器信息和配对码")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                // MQTT Server section
                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "server.rack")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        Text("MQTT 服务器")
                            .font(.subheadline.bold())
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.horizontal, 40)

                    VStack(spacing: 10) {
                        HStack(spacing: 8) {
                            TextField("服务器地址", text: $mqttHost)
                                .textContentType(.URL)
                                .autocapitalization(.none)
                                .disableAutocorrection(true)
                                .focused($focusedField, equals: .host)
                            TextField("端口", text: $mqttPort)
                                .keyboardType(.numberPad)
                                .focused($focusedField, equals: .port)
                                .frame(width: 70)
                        }
                        .textFieldStyle(.roundedBorder)

                        HStack(spacing: 8) {
                            TextField("用户名（可选）", text: $mqttUsername)
                                .autocapitalization(.none)
                                .disableAutocorrection(true)
                                .focused($focusedField, equals: .username)
                            SecureField("密码（可选）", text: $mqttPassword)
                                .focused($focusedField, equals: .password)
                        }
                        .textFieldStyle(.roundedBorder)
                    }
                    .padding(.horizontal, 40)
                }

                // Code input section
                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "number")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        Text("配对码")
                            .font(.subheadline.bold())
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.horizontal, 40)

                    TextField("000000", text: $code)
                        .font(.system(.title, design: .monospaced).bold())
                        .multilineTextAlignment(.center)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .focused($focusedField, equals: .code)
                        .onChange(of: code) { _, newValue in
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
                    // Save broker info for next time
                    let ud = UserDefaults.standard
                    ud.set(mqttHost, forKey: "teamclaw_pairing_broker_host")
                    ud.set(Int(mqttPort) ?? 8883, forKey: "teamclaw_pairing_broker_port")
                    ud.set(mqttUsername, forKey: "teamclaw_pairing_broker_username")
                    ud.set(mqttPassword, forKey: "teamclaw_pairing_broker_password")

                    pairingManager.pair(
                        with: code,
                        brokerHost: mqttHost,
                        brokerPort: UInt16(mqttPort) ?? 8883,
                        brokerUsername: mqttUsername.isEmpty ? nil : mqttUsername,
                        brokerPassword: mqttPassword.isEmpty ? nil : mqttPassword
                    )
                } label: {
                    Group {
                        if pairingManager.isPairing {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("配对")
                                .font(.headline)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .disabled(mqttHost.isEmpty || code.count != 6 || pairingManager.isPairing)
                .padding(.horizontal, 40)

                Spacer().frame(height: 20)
            }
        }
        .onAppear {
            focusedField = mqttHost.isEmpty ? .host : .code
        }
    }
}

// MARK: - Preview

#Preview {
    PairingView(pairingManager: PairingManager())
}
