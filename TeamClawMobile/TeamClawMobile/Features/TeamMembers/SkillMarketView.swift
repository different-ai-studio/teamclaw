import SwiftUI

struct MarketSkill: Identifiable {
    let id: String
    let name: String
    let description: String
    let category: String
    let icon: String
    let price: String
}

extension MarketSkill {
    static let mockData: [MarketSkill] = [
        MarketSkill(id: "ms1", name: "智能排期", description: "根据任务优先级和成员负载自动排期", category: "项目管理", icon: "calendar.badge.clock", price: "免费"),
        MarketSkill(id: "ms2", name: "自动翻译", description: "实时翻译团队沟通内容，支持 12 种语言", category: "沟通", icon: "globe", price: "免费"),
        MarketSkill(id: "ms3", name: "Bug 分类器", description: "自动对 Issue 分类打标、指派负责人", category: "工程", icon: "ladybug", price: "Pro"),
        MarketSkill(id: "ms4", name: "竞品监控", description: "自动追踪竞品动态，生成对比分析", category: "市场", icon: "binoculars", price: "Pro"),
        MarketSkill(id: "ms5", name: "知识库问答", description: "基于团队文档自动回答成员提问", category: "知识", icon: "books.vertical", price: "免费"),
        MarketSkill(id: "ms6", name: "周报生成", description: "自动汇总本周工作进展，生成结构化周报", category: "效率", icon: "doc.richtext", price: "免费"),
        MarketSkill(id: "ms7", name: "合同审查", description: "自动检查合同条款风险点", category: "法务", icon: "doc.viewfinder", price: "Pro"),
    ]
}

struct SkillMarketView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(MarketSkill.mockData) { skill in
                MarketSkillRow(skill: skill)
            }
            .navigationTitle("技能市场")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

/// Embeddable version for use inside an existing NavigationStack (e.g. FunctionPanel).
struct SkillMarketListView: View {
    var body: some View {
        List(MarketSkill.mockData) { skill in
            MarketSkillRow(skill: skill)
        }
        .navigationTitle("技能市场")
        .navigationBarTitleDisplayMode(.large)
    }
}

// MARK: - MarketSkillRow

struct MarketSkillRow: View {
    let skill: MarketSkill
    @State private var installed = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.purple.opacity(0.12))
                    .frame(width: 48, height: 48)

                Image(systemName: skill.icon)
                    .font(.title3)
                    .foregroundStyle(.purple)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(skill.name)
                        .fontWeight(.medium)

                    Text(skill.category)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(.teal)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.teal.opacity(0.1)))

                    if skill.price == "Pro" {
                        Text("Pro")
                            .font(.caption2)
                            .fontWeight(.bold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.orange.gradient))
                    }
                }

                Text(skill.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer()

            Button {
                withAnimation { installed = true }
            } label: {
                Text(installed ? "已安装" : "安装")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(installed ? Color.gray.opacity(0.15) : Color.purple)
                    .foregroundColor(installed ? .secondary : .white)
                    .clipShape(Capsule())
            }
            .disabled(installed)
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }
}
