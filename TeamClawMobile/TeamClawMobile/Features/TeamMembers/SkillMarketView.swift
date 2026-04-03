import SwiftUI

struct SkillMarketView: View {
    @ObservedObject var viewModel: SkillViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.personalSkills.isEmpty && viewModel.teamSkills.isEmpty {
                    ContentUnavailableView("暂无技能", systemImage: "puzzlepiece")
                } else {
                    skillList
                }
            }
            .navigationTitle("技能市场")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                viewModel.requestSkills()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear {
                viewModel.loadSkills()
            }
        }
    }

    private var skillList: some View {
        let allSkills = viewModel.personalSkills + viewModel.teamSkills
        return List(allSkills, id: \.id) { skill in
            SkillMarketRow(skill: skill)
        }
    }
}

/// Embeddable version for use inside an existing NavigationStack (e.g. FunctionPanel).
struct SkillMarketListView: View {
    @ObservedObject var viewModel: SkillViewModel

    var body: some View {
        Group {
            if viewModel.personalSkills.isEmpty && viewModel.teamSkills.isEmpty {
                ContentUnavailableView("暂无技能", systemImage: "puzzlepiece")
            } else {
                let allSkills = viewModel.personalSkills + viewModel.teamSkills
                List(allSkills, id: \.id) { skill in
                    SkillMarketRow(skill: skill)
                }
            }
        }
        .navigationTitle("技能市场")
        .navigationBarTitleDisplayMode(.large)
        .refreshable {
            viewModel.requestSkills()
        }
        .onAppear {
            viewModel.loadSkills()
        }
    }
}

// MARK: - SkillMarketRow

struct SkillMarketRow: View {
    let skill: Skill
    @State private var installed = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.purple.opacity(0.12))
                    .frame(width: 48, height: 48)

                Image(systemName: "puzzlepiece")
                    .font(.title3)
                    .foregroundStyle(.purple)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(skill.name)
                        .fontWeight(.medium)

                    Text(skill.isPersonal ? "个人" : "团队")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(.teal)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.teal.opacity(0.1)))
                }

                Text(skill.skillDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer()

            Circle()
                .fill(skill.isEnabled ? Color.green : Color.gray)
                .frame(width: 10, height: 10)
        }
        .padding(.vertical, 4)
    }
}
