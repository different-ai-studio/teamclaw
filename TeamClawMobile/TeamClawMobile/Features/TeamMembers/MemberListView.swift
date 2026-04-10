import SwiftUI

struct MemberListView: View {
    @ObservedObject var viewModel: MemberViewModel
    let mqttService: MQTTServiceProtocol
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var searchText = ""
    @State private var showFeaturedAllies = false
    @State private var showSkillMarket = false
    @State private var selectedMemberForAutomation: TeamMember?

    @StateObject private var talentViewModel: TalentViewModel
    @StateObject private var skillViewModel: SkillViewModel
    @StateObject private var taskViewModel: TaskViewModel

    init(viewModel: MemberViewModel, mqttService: MQTTServiceProtocol) {
        self.viewModel = viewModel
        self.mqttService = mqttService
        _talentViewModel = StateObject(wrappedValue: TalentViewModel(mqttService: mqttService))
        _skillViewModel = StateObject(wrappedValue: SkillViewModel(mqttService: mqttService))
        _taskViewModel = StateObject(wrappedValue: TaskViewModel(mqttService: mqttService))
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
                        NavigationLink {
                            MemberSessionsView(member: member, viewModel: viewModel)
                        } label: {
                            MemberRow(member: member)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                showSkillMarket = true
                            } label: {
                                Label("技能", systemImage: "puzzlepiece")
                            }
                            .tint(.purple)

                            Button {
                                showFeaturedAllies = true
                            } label: {
                                Label("搭档", systemImage: "cpu")
                            }
                            .tint(.blue)

                            Button {
                                selectedMemberForAutomation = member
                            } label: {
                                Label("自动化", systemImage: "gearshape.2")
                            }
                            .tint(.orange)
                        }
                    }
                }
            }
            .navigationTitle("团队成员")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        dismiss()
                    }
                }
            }
            .searchable(text: $searchText, prompt: "搜索")
            .refreshable {
                viewModel.requestMembers()
            }
            .onAppear {
                viewModel.setModelContext(modelContext)
                talentViewModel.setModelContext(modelContext)
                skillViewModel.setModelContext(modelContext)
                taskViewModel.setModelContext(modelContext)
                viewModel.loadMembers()
            }
            .sheet(isPresented: $showFeaturedAllies) {
                FeaturedAllyView(viewModel: talentViewModel)
            }
            .sheet(isPresented: $showSkillMarket) {
                SkillMarketView(viewModel: skillViewModel)
            }
            .sheet(item: $selectedMemberForAutomation) { member in
                NavigationStack {
                    MemberAutomationView(
                        memberName: member.name,
                        viewModel: taskViewModel
                    )
                }
            }
        }
    }
}

// MARK: - MemberRow

private struct MemberRow: View {
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
