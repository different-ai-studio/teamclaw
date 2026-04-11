import SwiftUI

struct MemberDetailView: View {
    let member: TeamMember
    @ObservedObject var viewModel: MemberViewModel

    var body: some View {
        List {
            // Header section
            Section {
                HStack(spacing: 16) {
                    ZStack {
                        Circle()
                            .fill(member.isAIAlly ? Color.blue.opacity(0.15) : Color.purple.opacity(0.15))
                            .frame(width: 64, height: 64)

                        if member.isAIAlly {
                            Image(systemName: "cpu")
                                .font(.title2)
                                .foregroundStyle(.blue)
                        } else {
                            Text(String(member.name.prefix(1)))
                                .font(.title2)
                                .fontWeight(.semibold)
                                .foregroundStyle(.purple)
                        }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Text(member.name)
                                .font(.title3)
                                .fontWeight(.semibold)

                            Text(member.isAIAlly ? "AI 搭档" : "成员")
                                .font(.caption)
                                .fontWeight(.medium)
                                .foregroundStyle(member.isAIAlly ? .blue : .secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(
                                    Capsule()
                                        .fill(member.isAIAlly ? Color.blue.opacity(0.1) : Color.secondary.opacity(0.1))
                                )
                        }

                        if let dept = member.department, !dept.isEmpty {
                            Text(dept)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }

                        if let note = member.note, !note.isEmpty {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .padding(.vertical, 8)
            }

            // Collaborative sessions section
            let sessions = viewModel.collaborativeSessions(for: member)
            Section("协作 Session") {
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
                    // Placeholder for new collaborative session
                } label: {
                    Label("新建协作 Session", systemImage: "plus.bubble")
                }
            }
        }
        .navigationTitle(member.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
