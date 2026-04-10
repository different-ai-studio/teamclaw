import SwiftUI
import SwiftData

// MARK: - ModelPickerView

struct ModelPickerView: View {
    let models: [String]
    @Binding var selectedModel: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(models, id: \.self) { model in
                Button {
                    selectedModel = model
                    dismiss()
                } label: {
                    HStack {
                        Text(model)
                            .foregroundStyle(.primary)
                        Spacer()
                        if model == selectedModel {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.blue)
                        }
                    }
                }
            }
            .navigationTitle("选择模型")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - ChatDetailView

struct ChatDetailView: View {
    let session: Session
    let mqttService: MQTTServiceProtocol

    @Environment(\.modelContext) private var modelContext
    @StateObject private var viewModel: ChatDetailViewModel

    @State private var showModelPicker = false
    @State private var scrollProxy: ScrollViewProxy?

    init(session: Session, mqttService: MQTTServiceProtocol) {
        self.session = session
        self.mqttService = mqttService
        _viewModel = StateObject(wrappedValue: ChatDetailViewModel(
            sessionID: session.id,
            mqttService: mqttService
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Offline banner
            if !viewModel.isDesktopOnline {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.slash")
                        .font(.caption)
                    Text("桌面端离线，消息将在重新连接后发送")
                        .font(.caption)
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(Color.orange)
            }

            // Message list
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if viewModel.isLoadingHistory {
                            ProgressView("加载历史消息...")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 40)
                        }

                        ForEach(viewModel.messages, id: \.id) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }

                        if viewModel.isStreaming {
                            StreamingTextView(content: viewModel.streamingContent)
                                .id("streaming")
                        }

                        // Bottom anchor for auto-scroll
                        Color.clear
                            .frame(height: 8)
                            .id("bottom")
                    }
                    .padding(.top, 8)
                }
                .refreshable {
                    viewModel.requestMessageHistory()
                }
                .onAppear {
                    scrollProxy = proxy
                }
                .onChange(of: viewModel.messages.count) {
                    scrollToBottom(proxy: proxy)
                }
                .onChange(of: viewModel.streamingContent) {
                    scrollToBottom(proxy: proxy)
                }
                .onChange(of: viewModel.isStreaming) {
                    scrollToBottom(proxy: proxy)
                }
            }

            // Input bar
            ChatInputBar(
                text: $viewModel.inputText,
                isDisabled: !viewModel.isDesktopOnline,
                isStreaming: viewModel.isStreaming,
                onSend: { viewModel.sendMessage() },
                onCancel: { viewModel.cancelStreaming() },
                onModelTap: { showModelPicker = true },
                onImageSelected: { image in
                    _ = image
                }
            )
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if session.isCollaborative && !session.collaboratorIDs.isEmpty {
                ToolbarItem(placement: .navigationBarTrailing) {
                    collaboratorAvatars
                }
            }
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerView(
                models: viewModel.availableModels,
                selectedModel: $viewModel.selectedModel
            )
        }
        .onAppear {
            viewModel.setModelContext(modelContext)
            viewModel.loadMessages()
        }
    }

    // MARK: - Collaborator Avatars

    private var collaboratorAvatars: some View {
        HStack(spacing: -8) {
            ForEach(session.collaboratorIDs.prefix(3), id: \.self) { collaboratorID in
                ZStack {
                    Circle()
                        .fill(Color.green.opacity(0.2))
                        .frame(width: 28, height: 28)
                    Text(String(collaboratorID.prefix(1)).uppercased())
                        .font(.caption2.bold())
                        .foregroundStyle(.green)
                }
            }
        }
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
    let container = try! ModelContainer(
        for: Session.self, ChatMessage.self,
        configurations: config
    )
    let context = container.mainContext

    let session = Session(
        id: "preview-session",
        title: "运营搭档",
        agentName: "运营",
        lastMessageContent: "你好",
        lastMessageTime: Date(),
        isCollaborative: true,
        collaboratorIDs: ["user-1", "user-2"]
    )
    context.insert(session)

    let mockMQTT = MockMQTTService()

    return NavigationStack {
        ChatDetailView(session: session, mqttService: mockMQTT)
    }
    .modelContainer(container)
}
