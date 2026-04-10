import Foundation
import SwiftData
import Combine

@MainActor
final class SessionListViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var filteredSessions: [Session] = []
    @Published var searchText = ""
    @Published var isLoading = false

    private(set) var modelContext: ModelContext?
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()
    private var loadingTimer: AnyCancellable?

    func setModelContext(_ context: ModelContext) {
        guard modelContext == nil else { return }
        modelContext = context
    }

    init(mqttService: MQTTServiceProtocol) {
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
        guard let modelContext else { return }
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
        guard let creds = PairingManager.currentCredentials else { return }
        if page == 1 { isLoading = true; startLoadingTimeout() }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_SessionSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = Int32(page)
        pg.pageSize = 50
        req.pagination = pg
        let msg = ProtoMQTTCoder.makeEnvelope(.sessionSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    private func startLoadingTimeout() {
        loadingTimer?.cancel()
        loadingTimer = Just(())
            .delay(for: .seconds(10), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in self?.isLoading = false }
    }

    private func handleSessionSync(_ response: Teamclaw_SessionSyncResponse) {
        guard let modelContext else { return }
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
            isLoading = false
            loadingTimer?.cancel()
            loadSessionsFromDB()
        }
    }

    private func loadSessionsFromDB() {
        guard let modelContext else { return }
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
        modelContext?.insert(session)
        try? modelContext?.save()
        sessions.insert(session, at: 0)
        applySearch()
        return session
    }

    func deleteSession(_ session: Session) {
        modelContext?.delete(session)
        try? modelContext?.save()
        loadSessionsFromDB()
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f
    }()

    func relativeTime(for date: Date) -> String {
        Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
