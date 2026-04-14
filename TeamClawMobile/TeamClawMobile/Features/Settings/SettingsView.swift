import SwiftUI

// MARK: - SettingsView

struct SettingsView: View {
    @ObservedObject var pairingManager: PairingManager
    @ObservedObject var connectionMonitor: ConnectionMonitor

    @State private var showUnpairConfirmation = false
    @AppStorage("devMode") private var devMode = false
    @State private var versionTapCount = 0

    var body: some View {
        NavigationStack {
            List {
                // MARK: Profile Section
                Section("个人资料") {
                    NavigationLink {
                        UsernameSettingView(pairingManager: pairingManager)
                    } label: {
                        HStack {
                            Text("昵称")
                            Spacer()
                            Text(pairingManager.username.isEmpty ? "未设置" : pairingManager.username)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // MARK: Team Section
                Section("团队") {
                    NavigationLink {
                        InviteView(pairingManager: pairingManager)
                    } label: {
                        Label("邀请成员", systemImage: "person.badge.plus")
                    }
                    .disabled(!pairingManager.isAuthenticated)
                }

                // MARK: Desktop Connection Section
                Section("桌面端连接") {
                    HStack {
                        Text("状态")
                        Spacer()
                        DesktopStatusBadge(
                            isOnline: connectionMonitor.isDesktopOnline,
                            deviceName: connectionMonitor.desktopDeviceName
                        )
                    }

                    if let deviceName = pairingManager.pairedDeviceName {
                        HStack {
                            Text("已配对设备")
                            Spacer()
                            Text(deviceName)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Button(role: .destructive) {
                        showUnpairConfirmation = true
                    } label: {
                        Text("解除配对")
                    }
                    .disabled(!pairingManager.isPaired)
                }

                // MARK: Notifications Section
                Section("通知") {
                    NavigationLink("通知设置") {
                        NotificationPrefView()
                    }
                }

                // MARK: MQTT Debug Section (dev mode only)
                if devMode {
                    Section("MQTT 调试") {
                        HStack {
                            Text("Broker 连接")
                            Spacer()
                            Circle()
                                .fill(connectionMonitor.isMQTTConnected ? .green :
                                      connectionMonitor.connectionState == .reconnecting ? .yellow : .red)
                                .frame(width: 8, height: 8)
                            Text(connectionMonitor.isMQTTConnected ? "已连接" :
                                 connectionMonitor.connectionState == .reconnecting ? "重连中…" : "未连接")
                                .foregroundStyle(.secondary)
                        }

                        HStack {
                            Text("Host")
                            Spacer()
                            Text(PairingManager.currentCredentials?.mqttHost ?? "—")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                                .lineLimit(1)
                        }

                        HStack {
                            Text("Port")
                            Spacer()
                            Text("\(PairingManager.currentCredentials?.mqttPort ?? 0)")
                                .foregroundStyle(.secondary)
                        }

                        if let creds = pairingManager.credentials {
                            HStack {
                                Text("Team ID")
                                Spacer()
                                Text(creds.teamID)
                                    .foregroundStyle(.secondary)
                                    .font(.caption)
                                    .lineLimit(1)
                            }

                            HStack {
                                Text("Device ID")
                                Spacer()
                                Text(creds.deviceID)
                                    .foregroundStyle(.secondary)
                                    .font(.caption)
                                    .lineLimit(1)
                            }

                            HStack {
                                Text("Desktop ID")
                                Spacer()
                                Text(creds.desktopDeviceID)
                                    .foregroundStyle(.secondary)
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                        }
                    }

                    if let creds = pairingManager.credentials {
                        Section("订阅 Topics") {
                            let topics = [
                                "teamclaw/\(creds.teamID)/\(creds.desktopDeviceID)/status",
                                "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/res",
                                "teamclaw/\(creds.teamID)/\(creds.deviceID)/task",
                                "teamclaw/\(creds.teamID)/\(creds.deviceID)/skill",
                                "teamclaw/\(creds.teamID)/\(creds.deviceID)/member",
                                "teamclaw/\(creds.teamID)/\(creds.deviceID)/talent",
                            ]
                            ForEach(topics, id: \.self) { topic in
                                Text(topic)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }

                // MARK: About Section
                Section("关于") {
                    HStack {
                        Text("版本")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        versionTapCount += 1
                        if versionTapCount >= 3 {
                            devMode.toggle()
                            versionTapCount = 0
                        }
                        // Reset tap count after 1 second
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                            versionTapCount = 0
                        }
                    }

                    if devMode {
                        HStack {
                            Text("开发者模式")
                            Spacer()
                            Text("已开启")
                                .foregroundStyle(.orange)
                        }
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.large)
            .confirmationDialog(
                "确定要解除配对吗？",
                isPresented: $showUnpairConfirmation,
                titleVisibility: .visible
            ) {
                Button("解除配对", role: .destructive) {
                    pairingManager.unpair()
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("解除配对后需要重新输入配对码才能连接桌面端。")
            }
        }
    }
}

// MARK: - Preview

#Preview {
    let pairingManager = PairingManager()
    let mockMQTT = MockMQTTService()
    let monitor = ConnectionMonitor(mqttService: mockMQTT)

    return SettingsView(pairingManager: pairingManager, connectionMonitor: monitor)
}
