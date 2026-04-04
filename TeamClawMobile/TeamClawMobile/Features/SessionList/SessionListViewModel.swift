import Foundation
import SwiftData
import Combine

@MainActor
final class SessionListViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var filteredSessions: [Session] = []
    @Published var searchText = ""

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService

        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_SessionSyncResponse? in
                if case .sessionSyncResponse(let resp) = msg.payload { return resp }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] response in
                self?.handleSessionSync(response)
            }
            .store(in: &cancellables)
    }

    func loadSessions() {
        let descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageTime, order: .reverse)]
        )
        do {
            sessions = try modelContext.fetch(descriptor)
            applySearch()
        } catch {
            sessions = []
            filteredSessions = []
        }

        requestSessions(page: 1)
    }

    func requestSessions(page: Int = 1) {
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_SessionSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = Int32(page)
        pg.pageSize = 50
        req.pagination = pg
        let msg = ProtoMQTTCoder.makeEnvelope(.sessionSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    private func handleSessionSync(_ response: Teamclaw_SessionSyncResponse) {
        for sessionData in response.sessions {
            let updated = Date(timeIntervalSince1970: TimeInterval(sessionData.updated))
            if let existing = sessions.first(where: { $0.id == sessionData.id }) {
                existing.title = sessionData.title
                existing.lastMessageTime = updated
            } else {
                let session = Session(
                    id: sessionData.id,
                    title: sessionData.title,
                    agentName: "AI",
                    lastMessageContent: "",
                    lastMessageTime: updated
                )
                modelContext.insert(session)
            }
        }
        try? modelContext.save()

        let pg = response.pagination
        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestSessions(page: Int(pg.page) + 1)
        } else {
            loadSessionsFromDB()
        }
    }

    private func loadSessionsFromDB() {
        let descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageTime, order: .reverse)]
        )
        sessions = (try? modelContext.fetch(descriptor)) ?? []
        applySearch()
    }

    func applySearch() {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            filteredSessions = sessions
        } else {
            filteredSessions = sessions.filter { session in
                session.title.localizedCaseInsensitiveContains(query) ||
                session.lastMessageContent.localizedCaseInsensitiveContains(query)
            }
        }
    }

    func createSession() -> Session {
        let session = Session(
            id: UUID().uuidString,
            title: "新会话",
            agentName: "AI",
            lastMessageContent: "",
            lastMessageTime: Date()
        )
        modelContext.insert(session)
        try? modelContext.save()
        sessions.insert(session, at: 0)
        applySearch()
        return session
    }

    func deleteSession(_ session: Session) {
        modelContext.delete(session)
        try? modelContext.save()
        loadSessionsFromDB()
    }

    func relativeTime(for date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
