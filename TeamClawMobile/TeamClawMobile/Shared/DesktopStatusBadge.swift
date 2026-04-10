import SwiftUI

struct DesktopStatusBadge: View {
    let isOnline: Bool
    let deviceName: String?

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isOnline ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(isOnline ? (deviceName ?? "桌面端在线") : "桌面端离线")
                .font(.caption2)
                .foregroundStyle(isOnline ? Color(.secondaryLabel) : Color.red)
        }
    }
}

#Preview("Online") {
    DesktopStatusBadge(isOnline: true, deviceName: "My MacBook")
}

#Preview("Offline") {
    DesktopStatusBadge(isOnline: false, deviceName: nil)
}
