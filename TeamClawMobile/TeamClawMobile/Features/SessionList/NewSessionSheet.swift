import SwiftUI
import SwiftData

// MARK: - NewSessionSheet

struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let onCreated: (Session) -> Void

    @State private var collaborators: [TeamMember] = []
    @State private var messageText: String = ""
    @State private var showMemberPicker = false
    @State private var memberSearchText = ""
    @State private var allMembers: [TeamMember] = []
    @FocusState private var isInputFocused: Bool

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                collaboratorsRow
                Divider()
                if showMemberPicker {
                    memberPickerSection
                }
                Spacer()
                inputBar
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .onAppear {
            loadMembers()
            isInputFocused = true
        }
    }

    // MARK: - Collaborators row

    private var collaboratorsRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("协作者")
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(collaborators, id: \.id) { member in
                        CollaboratorChip(name: member.name) {
                            collaborators.removeAll { $0.id == member.id }
                        }
                    }
                }
                .padding(.vertical, 1)
            }

            Spacer(minLength: 0)

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showMemberPicker.toggle()
                    if showMemberPicker { isInputFocused = false }
                }
            } label: {
                Image(systemName: showMemberPicker ? "xmark.circle.fill" : "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(showMemberPicker ? Color.secondary : Color.blue)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Member picker

    private var memberPickerSection: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
                TextField("搜索成员", text: $memberSearchText)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            Divider()

            let filtered = filteredMembers
            if filtered.isEmpty {
                Text("暂无成员")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
            } else {
                List(filtered, id: \.id) { member in
                    MemberPickerRow(member: member) {
                        collaborators.append(member)
                        withAnimation { showMemberPicker = false }
                        memberSearchText = ""
                        isInputFocused = true
                    }
                }
                .listStyle(.plain)
            }
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {} label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: 40, height: 40)
                    .liquidGlass(in: Circle())
            }

            HStack(alignment: .bottom, spacing: 4) {
                TextField("消息", text: $messageText, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...5)
                    .focused($isInputFocused)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .padding(.vertical, 10)

                if canSend {
                    Button(action: sendAndCreate) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(Color.green, in: Circle())
                    }
                    .padding(.trailing, 6)
                    .padding(.bottom, 6)
                }
            }
            .background(Color(.systemGray6), in: Capsule())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .padding(.bottom, 4)
    }

    // MARK: - Helpers

    private var filteredMembers: [TeamMember] {
        let unselected = allMembers.filter { m in !collaborators.contains(where: { $0.id == m.id }) }
        guard !memberSearchText.isEmpty else { return unselected }
        return unselected.filter { $0.name.localizedCaseInsensitiveContains(memberSearchText) }
    }

    private func loadMembers() {
        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
        allMembers = (try? modelContext.fetch(descriptor)) ?? []
    }

    private func sendAndCreate() {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let title = text.count > 40 ? String(text.prefix(40)) + "…" : text
        let session = Session(
            id: UUID().uuidString,
            title: title,
            agentName: collaborators.first?.name ?? "AI",
            lastMessageContent: text,
            lastMessageTime: Date(),
            isCollaborative: !collaborators.isEmpty,
            collaboratorIDs: collaborators.map(\.id)
        )
        modelContext.insert(session)
        try? modelContext.save()
        onCreated(session)
        dismiss()
    }
}

// MARK: - MemberPickerRow

private struct MemberPickerRow: View {
    let member: TeamMember
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                MemberChipAvatar(name: member.name, isAI: member.isAIAlly)
                VStack(alignment: .leading, spacing: 2) {
                    Text(member.name)
                        .foregroundStyle(.primary)
                    if let dept = member.department, !dept.isEmpty {
                        Text(dept)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if member.isAIAlly {
                    Text("AI")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundStyle(.blue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.blue.opacity(0.1), in: Capsule())
                }
            }
        }
    }
}

// MARK: - CollaboratorChip

private struct CollaboratorChip: View {
    let name: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(name)
                .font(.subheadline)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.semibold))
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .background(Color(.systemGray5), in: Capsule())
        .foregroundStyle(.primary)
    }
}

// MARK: - MemberChipAvatar

private struct MemberChipAvatar: View {
    let name: String
    let isAI: Bool

    private var avatarColor: Color {
        let colors: [Color] = [.blue, .purple, .orange, .green, .pink, .teal, .indigo]
        return colors[abs(name.hashValue) % colors.count]
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(avatarColor.opacity(0.18))
                .frame(width: 36, height: 36)
            if isAI {
                Image(systemName: "sparkles")
                    .font(.subheadline)
                    .foregroundStyle(avatarColor)
            } else {
                Text(String((name.isEmpty ? "?" : name).prefix(1)))
                    .font(.subheadline.bold())
                    .foregroundStyle(avatarColor)
            }
        }
    }
}
