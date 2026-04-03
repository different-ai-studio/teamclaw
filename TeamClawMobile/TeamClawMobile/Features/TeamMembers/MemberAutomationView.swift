import SwiftUI

struct MemberAutomationView: View {
    let memberName: String
    @ObservedObject var viewModel: TaskViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if viewModel.tasks.isEmpty {
                ContentUnavailableView("暂无自动化任务", systemImage: "gearshape.2")
            } else {
                List(viewModel.tasks, id: \.id) { task in
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(Color.orange.opacity(0.12))
                                .frame(width: 40, height: 40)

                            Image(systemName: "gearshape.2")
                                .foregroundStyle(.orange)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.name)
                                .fontWeight(.medium)

                            Text(task.cronExpression)
                                .font(.caption)
                                .monospaced()
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Circle()
                            .fill(task.status == .running || task.status == .idle ? Color.green : Color.gray.opacity(0.3))
                            .frame(width: 10, height: 10)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle("\(memberName) · 自动化")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            viewModel.requestAutomations()
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
        .onAppear {
            viewModel.loadTasks()
        }
    }
}
