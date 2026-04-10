import SwiftUI

// MARK: - NotificationPrefView

struct NotificationPrefView: View {
    @AppStorage("notify_chat") private var notifyChat = true
    @AppStorage("notify_task") private var notifyTask = true
    @AppStorage("notify_collab") private var notifyCollab = true

    var body: some View {
        List {
            Toggle("Agent 对话回复", isOn: $notifyChat)
            Toggle("任务执行结果", isOn: $notifyTask)
            Toggle("协作 Session 消息", isOn: $notifyCollab)
        }
        .navigationTitle("通知设置")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        NotificationPrefView()
    }
}
