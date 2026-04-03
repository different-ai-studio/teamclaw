import SwiftUI

struct FeaturedAlly: Identifiable {
    let id: String
    let name: String
    let description: String
    let category: String
    let icon: String
    let downloads: Int
}

extension FeaturedAlly {
    static let mockData: [FeaturedAlly] = [
        FeaturedAlly(id: "fa1", name: "日报助手", description: "自动汇总团队工作日报，生成周报摘要", category: "效率", icon: "doc.text", downloads: 1280),
        FeaturedAlly(id: "fa2", name: "代码审查员", description: "自动 Review PR，提供改进建议和安全检查", category: "工程", icon: "chevron.left.forwardslash.chevron.right", downloads: 3420),
        FeaturedAlly(id: "fa3", name: "客户跟进", description: "自动跟踪客户沟通记录，生成跟进提醒", category: "销售", icon: "person.wave.2", downloads: 890),
        FeaturedAlly(id: "fa4", name: "数据分析师", description: "自动分析业务数据，生成可视化报告", category: "数据", icon: "chart.bar", downloads: 2150),
        FeaturedAlly(id: "fa5", name: "会议纪要", description: "自动记录会议要点，生成 Action Item", category: "效率", icon: "list.clipboard", downloads: 4100),
        FeaturedAlly(id: "fa6", name: "文案创作", description: "辅助撰写营销文案、社媒内容", category: "市场", icon: "pencil.and.outline", downloads: 1750),
    ]
}

struct FeaturedAllyView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(FeaturedAlly.mockData) { ally in
                FeaturedAllyRow(ally: ally)
            }
            .navigationTitle("精选搭档")
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
struct FeaturedAllyListView: View {
    var body: some View {
        List(FeaturedAlly.mockData) { ally in
            FeaturedAllyRow(ally: ally)
        }
        .navigationTitle("精选搭档")
        .navigationBarTitleDisplayMode(.large)
    }
}

// MARK: - FeaturedAllyRow

struct FeaturedAllyRow: View {
    let ally: FeaturedAlly
    @State private var downloaded = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.blue.opacity(0.12))
                    .frame(width: 48, height: 48)

                Image(systemName: ally.icon)
                    .font(.title3)
                    .foregroundStyle(.blue)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(ally.name)
                        .fontWeight(.medium)

                    Text(ally.category)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.orange.opacity(0.1)))
                }

                Text(ally.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                Text("\(ally.downloads) 次下载")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            Button {
                withAnimation { downloaded = true }
            } label: {
                Text(downloaded ? "已添加" : "添加")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(downloaded ? Color.gray.opacity(0.15) : Color.blue)
                    .foregroundColor(downloaded ? .secondary : .white)
                    .clipShape(Capsule())
            }
            .disabled(downloaded)
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }
}
