import SwiftUI

// MARK: - SettingsView

struct SettingsView: View {
    @ObservedObject var pairingManager: PairingManager
    @ObservedObject var connectionMonitor: ConnectionMonitor

    @State private var showUnpairConfirmation = false

    var body: some View {
        NavigationStack {
            List {
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

                // MARK: About Section
                Section("关于") {
                    HStack {
                        Text("版本")
                        Spacer()
                        Text("1.0.0")
                            .foregroundStyle(.secondary)
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
