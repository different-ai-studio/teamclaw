import SwiftUI

struct TaskListView: View {
    @ObservedObject var viewModel: TaskViewModel
    @State private var showNewTask = false

    var body: some View {
        List {
            ForEach(viewModel.tasks, id: \.id) { task in
                NavigationLink {
                    TaskEditView(viewModel: viewModel, task: task)
                } label: {
                    TaskRow(task: task)
                }
            }
            .onDelete { offsets in
                for index in offsets {
                    viewModel.deleteTask(viewModel.tasks[index])
                }
            }
        }
        .navigationTitle("自动化")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showNewTask = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showNewTask) {
            NavigationStack {
                TaskEditView(viewModel: viewModel, task: nil)
            }
        }
        .refreshable {
            viewModel.requestAutomations()
        }
        .onAppear {
            viewModel.loadTasks()
        }
    }
}

// MARK: - TaskRow

private struct TaskRow: View {
    let task: AutomationTask

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(task.name)
                Spacer()
                StatusBadge(status: task.status)
            }

            Text(task.cronExpression)
                .font(.caption)
                .monospaced()
                .foregroundStyle(.secondary)

            if let lastRun = task.lastRunTime {
                Text("上次运行: \(lastRun, format: .dateTime)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - StatusBadge

private struct StatusBadge: View {
    let status: TaskStatus

    var body: some View {
        Text(statusText)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.15))
            .foregroundStyle(statusColor)
            .clipShape(Capsule())
    }

    private var statusText: String {
        switch status {
        case .running: "运行中"
        case .completed: "已完成"
        case .failed: "失败"
        case .idle: "空闲"
        }
    }

    private var statusColor: Color {
        switch status {
        case .running: .blue
        case .completed: .green
        case .failed: .red
        case .idle: .gray
        }
    }
}
