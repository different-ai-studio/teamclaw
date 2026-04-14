import SwiftUI
import SwiftData

// MARK: - CollabChatView

struct CollabChatView: View {
    let session: Session
    let mqttService: MQTTServiceProtocol

    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel: CollabChatViewModel

    @State private var showLeaveConfirm = false
    @State private var showEndConfirm = false

    init(session: Session, mqttService: MQTTServiceProtocol) {
        self.session = session
        self.mqttService = mqttService
        _viewModel = StateObject(wrappedValue: CollabChatViewModel(
            session: session,
            mqttService: mqttService
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Message list
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if viewModel.isLoadingHistory && viewModel.messages.isEmpty {
                            ProgressView("加载历史消息...")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 40)
                        }

                        ForEach(viewModel.messages, id: \.id) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }

                        Color.clear
                            .frame(height: 8)
                            .id("bottom")
                    }
                    .padding(.top, 8)
                }
                .refreshable {
                    viewModel.requestHistory()
                }
                .onChange(of: viewModel.messages.count) {
                    scrollToBottom(proxy: proxy)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            inputBar
        }
        .navigationTitle(session.title.isEmpty ? "协作会话" : session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    // Member count label
                    Label(
                        "\(session.collaboratorIDs.count) 位成员",
                        systemImage: "person.2.fill"
                    )
                    .disabled(true)

                    Divider()

                    if viewModel.isOwner {
                        Button(role: .destructive) {
                            showEndConfirm = true
                        } label: {
                            Label("结束会话", systemImage: "xmark.circle")
                        }
                    } else {
                        Button(role: .destructive) {
                            showLeaveConfirm = true
                        } label: {
                            Label("离开会话", systemImage: "arrow.left.circle")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog(
            "离开协作会话",
            isPresented: $showLeaveConfirm,
            titleVisibility: .visible
        ) {
            Button("离开", role: .destructive) {
                viewModel.leaveSession()
                dismiss()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("离开后其他成员将收到通知，您将不再接收此会话的消息。")
        }
        .confirmationDialog(
            "结束协作会话",
            isPresented: $showEndConfirm,
            titleVisibility: .visible
        ) {
            Button("结束", role: .destructive) {
                viewModel.endSession()
                dismiss()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("结束后所有成员将收到通知，会话将被归档。")
        }
        .onAppear {
            viewModel.setModelContext(modelContext)
            viewModel.loadMessages()
            if viewModel.messages.isEmpty {
                viewModel.requestHistory()
            }
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            HStack(alignment: .bottom, spacing: 4) {
                TextField("消息", text: $viewModel.inputText, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...5)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .padding(.vertical, 10)

                if !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(action: { viewModel.sendMessage() }) {
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
        .background(.bar)
    }

    // MARK: - Helpers

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}

// MARK: - Preview

#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: Session.self, ChatMessage.self, configurations: config)
    let context = container.mainContext

    let session = Session(
        id: "collab-preview",
        title: "协作会话",
        agentName: "AI 搭档",
        lastMessageContent: "",
        lastMessageTime: Date(),
        isCollaborative: true,
        collaboratorIDs: ["user-1", "user-2"],
        ownerNodeId: "user-1"
    )
    context.insert(session)

    let mockMQTT = MockMQTTService()

    return NavigationStack {
        CollabChatView(session: session, mqttService: mockMQTT)
    }
    .modelContainer(container)
}
