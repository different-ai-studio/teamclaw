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
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel: ChatDetailViewModel

    @State private var showMenuSheet = false
    @State private var showEditSheet = false
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
                        if viewModel.isLoadingHistory && viewModel.messages.isEmpty {
                            ProgressView("加载历史消息...")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 40)
                        }

                        ForEach(viewModel.messages, id: \.id) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }

                        if viewModel.isStreaming {
                            StreamingTextView(content: viewModel.streamingContent, streamingToolCalls: viewModel.streamingToolCalls)
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
        }
        .safeAreaInset(edge: .bottom) {
            ChatInputBar(
                text: $viewModel.inputText,
                isDisabled: !viewModel.isDesktopOnline,
                isStreaming: viewModel.isStreaming,
                session: session,
                onSend: { viewModel.sendMessage() },
                onCancel: { viewModel.cancelStreaming() },
                onImageSelected: { image in _ = image },
                onTogglePin: {
                    session.isPinned.toggle()
                    try? modelContext.save()
                },
                onArchive: {
                    session.isArchived = true
                    try? modelContext.save()
                    // Send archive to desktop via MQTT
                    if let creds = PairingManager.currentCredentials {
                        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
                        var req = Teamclaw_SessionArchiveRequest()
                        req.sessionIds = [session.id]
                        let msg = ProtoMQTTCoder.makeEnvelope(.sessionArchiveRequest(req))
                        mqttService.publish(topic: topic, message: msg, qos: 1)
                    }
                    dismiss()
                },
                onShowMenu: { showMenuSheet = true }
            )
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 16) {
                    Button {
                        viewModel.requestMessageHistory()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.primary)
                    }

                    Button {
                        showEditSheet = true
                    } label: {
                        Image(systemName: "person.badge.plus")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.primary)
                    }
                }
            }
        }
        .sheet(isPresented: $showEditSheet) {
            UnifiedMemberSheet(
                mode: .select(
                    preSelected: Set(session.collaboratorIDs),
                    onConfirm: { ids in
                        session.collaboratorIDs = Array(ids)
                        session.isCollaborative = !ids.isEmpty
                        try? modelContext.save()
                    }
                ),
                mqttService: mqttService
            )
        }
        .sheet(isPresented: $showMenuSheet) {
            ChatMenuSheet(
                availableModels: viewModel.availableModels,
                selectedModel: $viewModel.selectedModel
            )
        }
        .onAppear {
            viewModel.setModelContext(modelContext)
            viewModel.loadMessages()
        }
    }

    // MARK: - Helpers

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}

// MARK: - ChatMenuSheet

struct ChatMenuSheet: View {
    let availableModels: [String]
    @Binding var selectedModel: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("模型") {
                    ForEach(availableModels, id: \.self) { model in
                        Button {
                            selectedModel = model
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
                }

                Section("权限") {
                    HStack {
                        Label("自动审批", systemImage: "checkmark.shield")
                        Spacer()
                        Text("开启")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("会话设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
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
