import SwiftUI
import SwiftData

// MARK: - MemberListMode

enum MemberListMode {
    /// Browse mode — tap a row to navigate into MemberDetailView
    case browse
    /// Select mode — checkbox selection with confirm button
    case select(preSelected: Set<String>, onConfirm: (Set<String>) -> Void)
}

// MARK: - UnifiedMemberSheet

struct UnifiedMemberSheet: View {
    let mode: MemberListMode
    let mqttService: MQTTServiceProtocol

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @StateObject private var viewModel: MemberViewModel
    @State private var searchText = ""
    @State private var selectedIDs: Set<String> = []

    init(mode: MemberListMode, mqttService: MQTTServiceProtocol) {
        self.mode = mode
        self.mqttService = mqttService
        _viewModel = StateObject(wrappedValue: MemberViewModel(mqttService: mqttService))
    }

    private var isSelectMode: Bool {
        if case .select = mode { return true }
        return false
    }

    private var displayedMembers: [TeamMember] {
        if searchText.isEmpty {
            return viewModel.members
        }
        return viewModel.members.filter {
            $0.name.localizedCaseInsensitiveContains(searchText)
            || ($0.department?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.members.isEmpty {
                    ContentUnavailableView("暂无团队成员", systemImage: "person.3")
                } else {
                    List(displayedMembers, id: \.id) { member in
                        memberRow(member)
                    }
                }
            }
            .navigationTitle(isSelectMode ? "选择成员" : "团队成员")
            .navigationBarTitleDisplayMode(isSelectMode ? .inline : .large)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if isSelectMode {
                        Button("取消") { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSelectMode {
                        Button {
                            if case .select(_, let onConfirm) = mode {
                                onConfirm(selectedIDs)
                            }
                            dismiss()
                        } label: {
                            Text(selectedIDs.isEmpty ? "确定" : "确定 (\(selectedIDs.count))")
                                .font(.subheadline.weight(.semibold))
                        }
                    } else {
                        Button("完成") { dismiss() }
                    }
                }
            }
            .searchable(text: $searchText, prompt: "搜索")
            .refreshable {
                viewModel.requestMembers()
            }
            .onAppear {
                viewModel.setModelContext(modelContext)
                viewModel.loadMembers()
                if case .select(let preSelected, _) = mode {
                    selectedIDs = preSelected
                }
            }
        }
    }

    // MARK: - Row

    @ViewBuilder
    private func memberRow(_ member: TeamMember) -> some View {
        switch mode {
        case .browse:
            NavigationLink {
                MemberDetailView(member: member, viewModel: viewModel)
            } label: {
                MemberRow(member: member)
            }

        case .select:
            Button {
                if selectedIDs.contains(member.id) {
                    selectedIDs.remove(member.id)
                } else {
                    selectedIDs.insert(member.id)
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: selectedIDs.contains(member.id) ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(selectedIDs.contains(member.id) ? .blue : .secondary)
                    MemberRow(member: member)
                }
            }
        }
    }

}

// MARK: - MemberRow

struct MemberRow: View {
    let member: TeamMember

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(member.isAIAlly ? Color.blue.opacity(0.2) : Color.purple.opacity(0.2))
                    .frame(width: 44, height: 44)

                if member.isAIAlly {
                    Image(systemName: "cpu")
                        .font(.title3)
                        .foregroundStyle(.blue)
                } else {
                    Text(String(member.name.prefix(1)))
                        .font(.headline)
                        .foregroundStyle(.purple)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(member.name)
                        .fontWeight(.medium)

                    Text(member.isAIAlly ? "AI 搭档" : "成员")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(member.isAIAlly ? .blue : .secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill(member.isAIAlly ? Color.blue.opacity(0.1) : Color.secondary.opacity(0.1))
                        )
                }

                if let department = member.department, !department.isEmpty {
                    Text(department)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
