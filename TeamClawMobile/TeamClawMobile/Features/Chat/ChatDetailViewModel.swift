import Combine
import Foundation
import SwiftData

enum PermissionMode: String, CaseIterable, Identifiable {
    case `default` = "default"
    case acceptEdits = "acceptEdits"
    case plan = "plan"
    case yolo = "yolo"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .default: "默认"
        case .acceptEdits: "接受编辑"
        case .plan: "计划模式"
        case .yolo: "Yolo 模式"
        }
    }

    var icon: String {
        switch self {
        case .default: "shield"
        case .acceptEdits: "pencil.and.outline"
        case .plan: "list.bullet.clipboard"
        case .yolo: "bolt.fill"
        }
    }

    var description: String {
        switch self {
        case .default: "每次操作都需要确认"
        case .acceptEdits: "自动接受文件编辑"
        case .plan: "先制定计划再执行"
        case .yolo: "自动执行所有操作"
        }
    }
}

@MainActor
final class ChatDetailViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var streamingContent = ""
    @Published var isStreaming = false
    @Published var isLoadingHistory = false
    @Published var isDesktopOnline = true
    @Published var selectedModel: String = "default"
    @Published var availableModels: [String] = ["default"]
    @Published var permissionMode: PermissionMode = .default
    @Published var streamingToolCalls: [ToolCallInfo] = []
    private var hasStreamingThinking = false

    let sessionID: String
    private var modelContext: ModelContext?
    private let mqttService: MQTTServiceProtocol
    private let aggregator: MessageAggregator

    private var cancellables = Set<AnyCancellable>()
    private var currentStreamingMessageID: String?
    private var aggregatorCancellable: AnyCancellable?

    func setModelContext(_ context: ModelContext) {
        guard modelContext == nil else { return }
        modelContext = context
    }

    init(
        sessionID: String,
        mqttService: MQTTServiceProtocol,
        aggregator: MessageAggregator = MessageAggregator()
    ) {
        self.sessionID = sessionID
        self.mqttService = mqttService
        self.aggregator = aggregator

        subscribeToMQTT()
        subscribeToStatus()
    }

    func loadMessages() {
        guard let modelContext else { return }
        let sid = sessionID
        let descriptor = FetchDescriptor<ChatMessage>(
            predicate: #Predicate { $0.sessionID == sid },
            sortBy: [SortDescriptor(\.timestamp)]
        )
        do {
            messages = try modelContext.fetch(descriptor)
        } catch {
            messages = []
        }

        // Always sync with desktop to pick up any messages we don't have locally
        if isDesktopOnline {
            requestMessageHistory()
        }
    }

    func requestMessageHistory() {
        guard let creds = PairingManager.currentCredentials else { return }
        isLoadingHistory = true
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_MessageSyncRequest()
        req.sessionID = sessionID
        if let ocID = fetchSession()?.openCodeSessionID, !ocID.isEmpty {
            req.opencodeSessionID = ocID
        }
        let msg = ProtoMQTTCoder.makeEnvelope(.messageSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, isDesktopOnline else { return }

        let message = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .user,
            content: text,
            timestamp: Date()
        )
        modelContext?.insert(message)
        try? modelContext?.save()
        messages.append(message)
        inputText = ""

        var req = Teamclaw_ChatRequest()
        req.sessionID = sessionID
        req.content = text
        if selectedModel != "default" { req.model = selectedModel }
        if permissionMode != .default { req.permissionMode = permissionMode.rawValue }
        if let ocID = fetchSession()?.openCodeSessionID, !ocID.isEmpty {
            req.opencodeSessionID = ocID
        }

        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    func sendImageMessage(ossURL: String) {
        guard isDesktopOnline else { return }

        let message = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .user,
            content: "",
            timestamp: Date(),
            imageURL: ossURL
        )
        modelContext?.insert(message)
        try? modelContext?.save()
        messages.append(message)

        var req = Teamclaw_ChatRequest()
        req.sessionID = sessionID
        req.content = ""
        req.imageURL = ossURL
        if selectedModel != "default" { req.model = selectedModel }
        if permissionMode != .default { req.permissionMode = permissionMode.rawValue }
        if let ocID = fetchSession()?.openCodeSessionID, !ocID.isEmpty {
            req.opencodeSessionID = ocID
        }

        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    func cancelStreaming() {
        guard isStreaming else { return }
        var cancel = Teamclaw_ChatCancel()
        cancel.sessionID = sessionID
        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        let msg = ProtoMQTTCoder.makeEnvelope(.chatCancel(cancel))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] mqttMessage in
                guard let self else { return }
                switch mqttMessage.payload {
                case .chatResponse(let response) where response.sessionID == self.sessionID:
                    self.handleStreamChunk(response: response)
                case .messageSyncResponse(let response) where response.sessionID == self.sessionID:
                    self.handleMessageSync(response)
                default:
                    break
                }
            }
            .store(in: &cancellables)
    }

    private func subscribeToStatus() {
        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_StatusReport? in
                if case .statusReport(let status) = msg.payload { return status }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.isDesktopOnline = status.online
                if !status.availableModels.isEmpty {
                    self?.availableModels = status.availableModels
                }
            }
            .store(in: &cancellables)
    }

    private func handleMessageSync(_ response: Teamclaw_MessageSyncResponse) {
        guard let modelContext else { return }
        isLoadingHistory = false
        var newMessages: [ChatMessage] = []
        let existingIDs = Set(messages.map(\.id))
        // Also track content+role for dedup against locally created messages (which use different IDs)
        let existingContent = Set(messages.map { "\($0.role.rawValue):\($0.content.prefix(100))" })

        for data in response.messages {
            guard !existingIDs.contains(data.id) else { continue }
            let role: MessageRole = data.role == "assistant" ? .assistant : .user
            let contentKey = "\(role.rawValue):\(data.content.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))"
            guard !existingContent.contains(contentKey) else { continue }

            let messageParts: [MessagePart] = data.parts.map { partData in
                if partData.type == "tool" && partData.hasTool {
                    let t = partData.tool
                    return MessagePart(type: "tool", text: nil, tool: ToolCallInfo(
                        toolCallId: t.toolCallID,
                        toolName: t.toolName,
                        status: t.status,
                        argumentsJson: t.argumentsJson,
                        resultSummary: t.resultSummary,
                        durationMs: Int(t.durationMs)
                    ))
                } else {
                    return MessagePart(type: "text", text: partData.hasText ? partData.text : nil, tool: nil)
                }
            }
            let partsData = (try? JSONEncoder().encode(messageParts)) ?? Data()
            let partsJSON = String(data: partsData, encoding: .utf8) ?? "[]"

            let displayContent = data.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !displayContent.isEmpty || !messageParts.isEmpty else { continue }

            let message = ChatMessage(
                id: data.id,
                sessionID: sessionID,
                role: role,
                content: displayContent,
                timestamp: Date(timeIntervalSince1970: data.timestamp),
                imageURL: data.hasImageURL ? data.imageURL : nil,
                partsJSON: partsJSON,
                hasThinking: data.hasThinking_p
            )
            modelContext.insert(message)
            newMessages.append(message)
        }

        if !newMessages.isEmpty {
            try? modelContext.save()
            // Reload all messages sorted by timestamp
            let sid = sessionID
            let descriptor = FetchDescriptor<ChatMessage>(
                predicate: #Predicate { $0.sessionID == sid },
                sortBy: [SortDescriptor(\.timestamp)]
            )
            messages = (try? modelContext.fetch(descriptor)) ?? messages
        }
    }

    func handleStreamChunk(response: Teamclaw_ChatResponse) {
        if !isStreaming {
            isStreaming = true
            streamingContent = ""
            let messageID = UUID().uuidString
            currentStreamingMessageID = messageID

            aggregatorCancellable = aggregator.assembledContent(for: messageID)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] content in
                    self?.streamingContent = content
                }
        }

        guard let messageID = currentStreamingMessageID else { return }
        aggregator.feed(messageID: messageID, chunk: response)

        switch response.event {
        case .done(let doneMsg):
            // Save opencode_session_id for future requests
            if doneMsg.hasOpencodeSessionID, !doneMsg.opencodeSessionID.isEmpty {
                if let session = fetchSession() {
                    session.openCodeSessionID = doneMsg.opencodeSessionID
                    try? modelContext?.save()
                }
            }
            // Read final content directly from aggregator to avoid race with async Combine pipeline
            let finalContent = aggregator.currentContent(for: messageID)
            finishStreaming(messageID: messageID, content: finalContent)
        case .error(let err):
            let finalContent = aggregator.currentContent(for: messageID)
            finishStreaming(messageID: messageID, content: finalContent + "\n[Error: \(err.message)]")

        case .toolEvent(let toolEvent):
            let info = ToolCallInfo(
                toolCallId: toolEvent.toolCallID,
                toolName: toolEvent.toolName,
                status: toolEvent.status,
                argumentsJson: toolEvent.argumentsJson,
                resultSummary: toolEvent.resultSummary,
                durationMs: Int(toolEvent.durationMs)
            )
            if let idx = streamingToolCalls.firstIndex(where: { $0.toolCallId == info.toolCallId }) {
                streamingToolCalls[idx] = info
            } else {
                streamingToolCalls.append(info)
            }

        case .hasThinking_p(let flag):
            if flag {
                hasStreamingThinking = true
                // Clear thinking text from streaming — everything before this was thinking content
                aggregator.reset(messageID: messageID)
                streamingContent = ""
            }

        default:
            break
        }
    }

    private func fetchSession() -> Session? {
        guard let modelContext else { return nil }
        let sid = sessionID
        let descriptor = FetchDescriptor<Session>(predicate: #Predicate { $0.id == sid })
        return try? modelContext.fetch(descriptor).first
    }

    private func finishStreaming(messageID: String, content: String) {
        isStreaming = false

        var messageParts: [MessagePart] = []
        if !content.isEmpty {
            messageParts.append(MessagePart(type: "text", text: content, tool: nil))
        }
        for tool in streamingToolCalls {
            messageParts.append(MessagePart(type: "tool", text: nil, tool: tool))
        }
        let partsData = (try? JSONEncoder().encode(messageParts)) ?? Data()
        let partsJSON = String(data: partsData, encoding: .utf8) ?? "[]"

        let assistantMessage = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .assistant,
            content: content,
            timestamp: Date(),
            partsJSON: partsJSON,
            hasThinking: hasStreamingThinking
        )
        modelContext?.insert(assistantMessage)
        try? modelContext?.save()
        messages.append(assistantMessage)

        streamingContent = ""
        streamingToolCalls = []
        hasStreamingThinking = false
        aggregator.reset(messageID: messageID)
        currentStreamingMessageID = nil
        aggregatorCancellable = nil

        requestSessionRefresh()
    }

    private func requestSessionRefresh() {
        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_SessionSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = 1; pg.pageSize = 50
        req.pagination = pg
        mqttService.publish(topic: topic, message: ProtoMQTTCoder.makeEnvelope(.sessionSyncRequest(req)), qos: 1)
    }
}
