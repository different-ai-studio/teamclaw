import SwiftUI

struct SkillHomeView: View {
    @ObservedObject var viewModel: SkillViewModel

    var body: some View {
        Group {
            if viewModel.personalSkills.isEmpty && viewModel.teamSkills.isEmpty {
                ContentUnavailableView("暂无技能", systemImage: "puzzlepiece")
            } else {
                List {
                    if !viewModel.personalSkills.isEmpty {
                        Section("我的技能") {
                            ForEach(viewModel.personalSkills, id: \.id) { skill in
                                SkillRow(skill: skill)
                            }
                        }
                    }

                    if !viewModel.teamSkills.isEmpty {
                        Section("团队技能") {
                            ForEach(viewModel.teamSkills, id: \.id) { skill in
                                SkillRow(skill: skill)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("技能")
        .navigationBarTitleDisplayMode(.large)
        .refreshable {
            viewModel.requestSkills()
        }
        .onAppear {
            viewModel.loadSkills()
        }
    }
}

// MARK: - SkillRow

private struct SkillRow: View {
    let skill: Skill

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name)
                    .fontWeight(.medium)

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
    }
}
