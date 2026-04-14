import Combine
import Foundation
import SwiftData

// MARK: - CollabChatViewModel

@MainActor
final class CollabChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText: String = ""
    @Published var isLoadingHistory: Bool = false

    let session: Session

    private let mqttService: MQTTServiceProtocol
    private var modelContext: ModelContext?
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Computed

    var isOwner: Bool {
        guard let creds = PairingManager.currentCredentials else { return false }
        return session.ownerNodeId == creds.deviceID
    }

    private var sessionTopic: String {
        guard let creds = PairingManager.currentCredentials else { return "" }
        return "teamclaw/\(creds.teamID)/session/\(session.id)"
    }

    // MARK: - Init

    init(session: Session, mqttService: MQTTServiceProtocol) {
        self.session = session
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    func setModelContext(_ context: ModelContext) {
        guard modelContext == nil else { return }
        modelContext = context
    }

    // MARK: - Load local messages

    func loadMessages() {
        guard let modelContext else { return }
        let sid = session.id
        let descriptor = FetchDescriptor<ChatMessage>(
            predicate: #Predicate { $0.sessionID == sid },
            sortBy: [SortDescriptor(\.timestamp)]
        )
        messages = (try? modelContext.fetch(descriptor)) ?? []
    }

    // MARK: - Send Message

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let creds = PairingManager.currentCredentials else { return }

        let username = UserDefaults.standard.string(forKey: "teamclaw_username") ?? creds.deviceID

        let localMessage = ChatMessage(
            id: UUID().uuidString,
            sessionID: session.id,
            role: .user,
            content: text,
            timestamp: Date(),
            senderName: username
        )
        modelContext?.insert(localMessage)
        try? modelContext?.save()
        messages.append(localMessage)
        inputText = ""

        var req = Teamclaw_ChatRequest()
        req.sessionID = session.id
        req.content = text
        req.senderID = creds.deviceID
        req.senderName = username
        req.senderType = "human"

        let envelope = ProtoMQTTCoder.makeEnvelope(.chatRequest(req))
        mqttService.publish(topic: sessionTopic, message: envelope, qos: 1)
    }

    // MARK: - Request History

    func requestHistory() {
        guard !sessionTopic.isEmpty else { return }
        isLoadingHistory = true
        var req = Teamclaw_MessageSyncRequest()
        req.sessionID = session.id
        let envelope = ProtoMQTTCoder.makeEnvelope(.messageSyncRequest(req))
        mqttService.publish(topic: sessionTopic, message: envelope, qos: 1)
    }

    // MARK: - Leave / End Session

    func leaveSession() {
        guard let creds = PairingManager.currentCredentials else { return }
        let username = UserDefaults.standard.string(forKey: "teamclaw_username") ?? creds.deviceID

        var control = Teamclaw_CollabControl()
        control.type = .collabLeave
        control.senderID = creds.deviceID
        control.senderName = username
        control.sessionID = session.id

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(control))
        mqttService.publish(topic: sessionTopic, message: envelope, qos: 1)
        unsubscribeSession()
    }

    func endSession() {
        guard let creds = PairingManager.currentCredentials else { return }
        let username = UserDefaults.standard.string(forKey: "teamclaw_username") ?? creds.deviceID

        var control = Teamclaw_CollabControl()
        control.type = .collabEnd
        control.senderID = creds.deviceID
        control.senderName = username
        control.sessionID = session.id

        let envelope = ProtoMQTTCoder.makeEnvelope(.collabControl(control))
        mqttService.publish(topic: sessionTopic, message: envelope, qos: 1)
        unsubscribeSession()
    }

    // MARK: - MQTT Subscription

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .receive(on: DispatchQueue.main)
            .sink { [weak self] mqttMessage in
                guard let self else { return }
                switch mqttMessage.payload {
                case .chatRequest(let req) where req.sessionID == self.session.id:
                    self.handleIncomingChatRequest(req)
                case .messageSyncResponse(let res) where res.sessionID == self.session.id:
                    self.handleMessageSync(res)
                case .collabControl(let ctrl) where ctrl.sessionID == self.session.id:
                    self.handleCollabControl(ctrl)
                default:
                    break
                }
            }
            .store(in: &cancellables)
    }

    private func unsubscribeSession() {
        if !sessionTopic.isEmpty {
            mqttService.unsubscribe(topic: sessionTopic)
        }
        cancellables.removeAll()
    }

    // MARK: - Handle Incoming Chat Request

    private func handleIncomingChatRequest(_ req: Teamclaw_ChatRequest) {
        guard let creds = PairingManager.currentCredentials else { return }

        // Ignore our own messages (already added locally in sendMessage)
        if req.hasSenderID && req.senderID == creds.deviceID { return }

        let role: MessageRole = req.hasSenderType && req.senderType == "human" ? .collaborator : .assistant
        let senderName: String? = req.hasSenderName && !req.senderName.isEmpty ? req.senderName : nil

        let message = ChatMessage(
            id: UUID().uuidString,
            sessionID: session.id,
            role: role,
            content: req.content,
            timestamp: Date(),
            senderName: senderName
        )
        modelContext?.insert(message)
        try? modelContext?.save()
        messages.append(message)
    }

    // MARK: - Handle Message Sync

    private func handleMessageSync(_ response: Teamclaw_MessageSyncResponse) {
        guard let modelContext else { return }
        isLoadingHistory = false

        let existingIDs = Set(messages.map(\.id))
        var newMessages: [ChatMessage] = []

        for data in response.messages {
            guard !existingIDs.contains(data.id) else { continue }

            let displayContent = data.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !displayContent.isEmpty else { continue }

            let role: MessageRole = data.role == "assistant" ? .assistant
                : data.role == "collaborator" ? .collaborator
                : .user

            let senderName: String? = data.hasSenderName && !data.senderName.isEmpty ? data.senderName : nil

            let message = ChatMessage(
                id: data.id,
                sessionID: session.id,
                role: role,
                content: displayContent,
                timestamp: Date(timeIntervalSince1970: data.timestamp),
                senderName: senderName
            )
            modelContext.insert(message)
            newMessages.append(message)
        }

        if !newMessages.isEmpty {
            try? modelContext.save()
            let sid = session.id
            let descriptor = FetchDescriptor<ChatMessage>(
                predicate: #Predicate { $0.sessionID == sid },
                sortBy: [SortDescriptor(\.timestamp)]
            )
            messages = (try? modelContext.fetch(descriptor)) ?? messages
        }
    }

    // MARK: - Handle CollabControl

    private func handleCollabControl(_ ctrl: Teamclaw_CollabControl) {
        guard let creds = PairingManager.currentCredentials else { return }

        switch ctrl.type {
        case .collabLeave:
            let name = ctrl.senderName.isEmpty ? ctrl.senderID : ctrl.senderName
            let systemMsg = ChatMessage(
                id: UUID().uuidString,
                sessionID: session.id,
                role: .assistant,
                content: "\(name) 已离开协作会话",
                timestamp: Date()
            )
            modelContext?.insert(systemMsg)
            try? modelContext?.save()
            messages.append(systemMsg)

        case .collabEnd:
            let name = ctrl.senderName.isEmpty ? ctrl.senderID : ctrl.senderName
            let systemMsg = ChatMessage(
                id: UUID().uuidString,
                sessionID: session.id,
                role: .assistant,
                content: "\(name) 已结束协作会话",
                timestamp: Date()
            )
            modelContext?.insert(systemMsg)

            // Archive session
            session.isArchived = true
            try? modelContext?.save()
            messages.append(systemMsg)

            // Only unsubscribe if we are not the one who ended (we already unsubscribed in endSession)
            if ctrl.senderID != creds.deviceID {
                unsubscribeSession()
            }

        default:
            break
        }
    }
}
