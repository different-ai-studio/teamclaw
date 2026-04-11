import SwiftUI
import SwiftData

// MARK: - NewSessionSheet

struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let mqttService: MQTTServiceProtocol
    let onCreated: (Session) -> Void

    @State private var collaborators: [TeamMember] = []
    @State private var messageText: String = ""
    @State private var showMemberPicker = false
    @FocusState private var isInputFocused: Bool

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                collaboratorsRow
                Divider()
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
        .sheet(isPresented: $showMemberPicker) {
            UnifiedMemberSheet(
                mode: .select(
                    preSelected: Set(collaborators.map(\.id)),
                    onConfirm: { ids in
                        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
                        let allMembers = (try? modelContext.fetch(descriptor)) ?? []
                        collaborators = allMembers.filter { ids.contains($0.id) }
                    }
                ),
                mqttService: mqttService
            )
        }
        .onAppear {
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
                showMemberPicker = true
                isInputFocused = false
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.blue)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
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
