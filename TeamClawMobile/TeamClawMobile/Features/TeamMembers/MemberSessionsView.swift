import SwiftUI

struct MemberSessionsView: View {
    let member: TeamMember
    @ObservedObject var viewModel: MemberViewModel

    var body: some View {
        let sessions = viewModel.collaborativeSessions(for: member)

        List {
            Section("与 \(member.name) 的协作 Session") {
                if sessions.isEmpty {
                    Text("暂无协作 Session")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(sessions, id: \.id) { session in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(session.title)
                                .fontWeight(.medium)

                            Text(session.lastMessageContent)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            Section {
                Button {
                    // Placeholder action for new collaborative session
                } label: {
                    Label("新建协作 Session", systemImage: "plus.bubble")
                }
            }
        }
        .navigationTitle(member.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
