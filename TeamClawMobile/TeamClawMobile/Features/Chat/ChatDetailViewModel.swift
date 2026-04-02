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

    // MARK: - Load Messages

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

    // MARK: - Send Message

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

        let payload = ChatRequestPayload(
            sessionID: sessionID,
            content: text,
            imageURL: nil,
            model: selectedModel == "default" ? nil : selectedModel
        )
        let mqttMessage = MQTTMessage(
            id: UUID().uuidString,
            type: .chatRequest,
            timestamp: Date().timeIntervalSince1970,
            payload: .chatRequest(payload)
        )
        mqttService.publish(topic: "chat/request", message: mqttMessage, qos: 1)
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

        let payload = ChatRequestPayload(
            sessionID: sessionID,
            content: "",
            imageURL: ossURL,
            model: selectedModel == "default" ? nil : selectedModel
        )
        let mqttMessage = MQTTMessage(
            id: UUID().uuidString,
            type: .chatRequest,
            timestamp: Date().timeIntervalSince1970,
            payload: .chatRequest(payload)
        )
        mqttService.publish(topic: "chat/request", message: mqttMessage, qos: 1)
    }

    // MARK: - MQTT Subscription

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] mqttMessage in
                guard let self else { return }
                if case .chatResponse(let payload) = mqttMessage.payload,
                   payload.sessionID == self.sessionID {
                    self.handleStreamChunk(payload: payload)
                }
            }
            .store(in: &cancellables)
    }

    func handleStreamChunk(payload: ChatResponsePayload) {
        // Start streaming if not already
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
        aggregator.feed(messageID: messageID, chunk: payload)

        if payload.done {
            let finalContent = payload.full ?? streamingContent
            isStreaming = false

            let assistantMessage = ChatMessage(
                id: UUID().uuidString,
                sessionID: sessionID,
                role: .assistant,
                content: finalContent,
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
}
