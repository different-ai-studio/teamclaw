import SwiftUI

struct MockAutomation: Identifiable {
    let id: String
    let name: String
    let trigger: String
    let icon: String
    let isEnabled: Bool
}

extension MockAutomation {
    static let mockData: [MockAutomation] = [
        MockAutomation(id: "a1", name: "每日站会提醒", trigger: "每天 9:30", icon: "bell", isEnabled: true),
        MockAutomation(id: "a2", name: "周报自动生成", trigger: "每周五 17:00", icon: "doc.text", isEnabled: true),
        MockAutomation(id: "a3", name: "代码提交通知", trigger: "Git Push 时", icon: "arrow.up.circle", isEnabled: false),
        MockAutomation(id: "a4", name: "任务超时预警", trigger: "截止前 2 小时", icon: "exclamationmark.triangle", isEnabled: true),
    ]
}

struct MemberAutomationView: View {
    let memberName: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(MockAutomation.mockData) { automation in
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color.orange.opacity(0.12))
                        .frame(width: 40, height: 40)

                    Image(systemName: automation.icon)
                        .foregroundStyle(.orange)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(automation.name)
                        .fontWeight(.medium)

                    Text(automation.trigger)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Circle()
                    .fill(automation.isEnabled ? Color.green : Color.gray.opacity(0.3))
                    .frame(width: 10, height: 10)
            }
            .padding(.vertical, 2)
        }
        .navigationTitle("\(memberName) · 自动化")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
    }
}
