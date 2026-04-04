import Combine
import Foundation
import SwiftData

@MainActor
final class ChatDetailViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var streamingContent = ""
    @Published var isStreaming = false
    @Published var isDesktopOnline = true
    @Published var selectedModel: String = "default"
    @Published var availableModels: [String] = ["default"]

    let sessionID: String
    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private let aggregator: MessageAggregator

    private var cancellables = Set<AnyCancellable>()
    private var currentStreamingMessageID: String?
    private var aggregatorCancellable: AnyCancellable?

    init(
        sessionID: String,
        modelContext: ModelContext,
        mqttService: MQTTServiceProtocol,
        aggregator: MessageAggregator = MessageAggregator()
    ) {
        self.sessionID = sessionID
        self.modelContext = modelContext
        self.mqttService = mqttService
        self.aggregator = aggregator

        subscribeToMQTT()
    }

    func loadMessages() {
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
        modelContext.insert(message)
        try? modelContext.save()
        messages.append(message)
        inputText = ""

        var req = Teamclaw_ChatRequest()
        req.sessionID = sessionID
        req.content = text
        if selectedModel != "default" { req.model = selectedModel }

        guard let creds = PairingManager().credentials else { return }
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
        modelContext.insert(message)
        try? modelContext.save()
        messages.append(message)

        var req = Teamclaw_ChatRequest()
        req.sessionID = sessionID
        req.content = ""
        req.imageURL = ossURL
        if selectedModel != "default" { req.model = selectedModel }

        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        let msg = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    func cancelStreaming() {
        guard isStreaming else { return }
        var cancel = Teamclaw_ChatCancel()
        cancel.sessionID = sessionID
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        let msg = ProtoMQTTCoder.makeEnvelope(.chatCancel(cancel))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] mqttMessage in
                guard let self else { return }
                if case .chatResponse(let response) = mqttMessage.payload,
                   response.sessionID == self.sessionID {
                    self.handleStreamChunk(response: response)
                }
            }
            .store(in: &cancellables)
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
        case .done:
            finishStreaming(messageID: messageID, content: streamingContent)
        case .error(let err):
            finishStreaming(messageID: messageID, content: streamingContent + "\n[Error: \(err.message)]")
        default:
            break
        }
    }

    private func finishStreaming(messageID: String, content: String) {
        isStreaming = false

        let assistantMessage = ChatMessage(
            id: UUID().uuidString,
            sessionID: sessionID,
            role: .assistant,
            content: content,
            timestamp: Date()
        )
        modelContext.insert(assistantMessage)
        try? modelContext.save()
        messages.append(assistantMessage)

        streamingContent = ""
        aggregator.reset(messageID: messageID)
        currentStreamingMessageID = nil
        aggregatorCancellable = nil
    }
}
