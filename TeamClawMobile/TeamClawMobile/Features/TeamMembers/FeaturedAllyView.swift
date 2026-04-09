import SwiftUI

struct FeaturedAllyView: View {
    @ObservedObject var viewModel: TalentViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if !viewModel.isDesktopOnline && viewModel.talents.isEmpty {
                    ContentUnavailableView(
                        "桌面端离线",
                        systemImage: "wifi.slash",
                        description: Text("连接桌面端后查看精选搭档")
                    )
                } else if viewModel.talents.isEmpty {
                    ContentUnavailableView("暂无精选搭档", systemImage: "cpu")
                } else {
                    List(viewModel.talents, id: \.id) { talent in
                        NavigationLink {
                            RoleDetailView(talent: talent)
                        } label: {
                            FeaturedAllyRow(talent: talent)
                        }
                    }
                }
            }
            .navigationTitle("精选搭档")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                viewModel.requestTalents()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear {
                viewModel.loadTalents()
            }
        }
    }
}

/// Embeddable version for use inside an existing NavigationStack (e.g. FunctionPanel).
struct FeaturedAllyListView: View {
    @ObservedObject var viewModel: TalentViewModel

    var body: some View {
        Group {
            if !viewModel.isDesktopOnline && viewModel.talents.isEmpty {
                ContentUnavailableView(
                    "桌面端离线",
                    systemImage: "wifi.slash",
                    description: Text("连接桌面端后查看精选搭档")
                )
            } else if viewModel.talents.isEmpty {
                ContentUnavailableView("暂无精选搭档", systemImage: "cpu")
            } else {
                List(viewModel.talents, id: \.id) { talent in
                    NavigationLink {
                        RoleDetailView(talent: talent)
                    } label: {
                        FeaturedAllyRow(talent: talent)
                    }
                }
            }
        }
        .navigationTitle("精选搭档")
        .navigationBarTitleDisplayMode(.large)
        .refreshable {
            viewModel.requestTalents()
        }
        .onAppear {
            viewModel.loadTalents()
        }
    }
}

// MARK: - FeaturedAllyRow

struct FeaturedAllyRow: View {
    let talent: Talent

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.blue.opacity(0.12))
                    .frame(width: 48, height: 48)

                Image(systemName: talent.icon)
                    .font(.title3)
                    .foregroundStyle(.blue)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(talent.name)
                        .fontWeight(.medium)

                    Text(talent.category)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.orange.opacity(0.1)))
                }

                Text(talent.talentDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                if talent.downloads > 0 {
                    Text("\(talent.downloads) 个技能")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
