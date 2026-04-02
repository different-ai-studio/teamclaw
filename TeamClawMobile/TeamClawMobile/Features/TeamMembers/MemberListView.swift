import SwiftUI

struct MemberListView: View {
    @ObservedObject var viewModel: MemberViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.members.isEmpty {
                    ContentUnavailableView("暂无团队成员", systemImage: "person.3")
                } else {
                    List(viewModel.members, id: \.id) { member in
                        NavigationLink {
                            MemberSessionsView(member: member, viewModel: viewModel)
                        } label: {
                            MemberRow(member: member)
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
            .onAppear {
                viewModel.loadMembers()
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
                    .fill(Color.purple.opacity(0.2))
                    .frame(width: 40, height: 40)

                Text(String(member.name.prefix(1)))
                    .font(.headline)
                    .foregroundStyle(.purple)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(member.name)
                    .fontWeight(.medium)

                if let note = member.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
