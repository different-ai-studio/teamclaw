import SwiftUI

struct TaskEditView: View {
    @ObservedObject var viewModel: TaskViewModel
    let task: AutomationTask?

    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var cron: String = ""
    @State private var taskDescription: String = ""

    private var isEditing: Bool { task != nil }

    var body: some View {
        Form {
            TextField("任务名称", text: $name)

            TextField("Cron 表达式", text: $cron)
                .monospaced()

            TextField("任务描述", text: $taskDescription, axis: .vertical)
                .lineLimit(3...6)
        }
        .navigationTitle(isEditing ? "编辑任务" : "新建任务")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") {
                    dismiss()
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    save()
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .onAppear {
            if let task {
                name = task.name
                cron = task.cronExpression
                taskDescription = task.taskDescription
            }
        }
    }

    private func save() {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else { return }

        if let task {
            viewModel.updateTask(task, name: trimmedName, cron: cron, description: taskDescription)
        } else {
            viewModel.addTask(name: trimmedName, cron: cron, description: taskDescription)
        }
        dismiss()
    }
}
