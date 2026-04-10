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
    // Buffer for MQTT responses that arrived before modelContext was set
    private var pendingSessionResponse: Teamclaw_SessionSyncResponse?

    func setModelContext(_ context: ModelContext) {
        guard modelContext == nil else { return }
        modelContext = context
        // Process any response that arrived before the context was ready
        if let pending = pendingSessionResponse {
            pendingSessionResponse = nil
            handleSessionSync(pending)
        }
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

        // Re-request sessions whenever MQTT (re)connects — covers reconnects after sleep/background
        mqttService.isConnected
            .removeDuplicates()
            .filter { $0 }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                // Only re-fetch if the view is active (modelContext set) and we have no sessions yet
                guard let self, self.modelContext != nil, self.sessions.isEmpty else { return }
                self.requestSessions()
            }
            .store(in: &cancellables)
    }

    func loadSessions() {
        guard let modelContext else {
            NSLog("[SessionList] loadSessions: modelContext is nil — skipping")
            return
        }
        let descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageTime, order: .reverse)]
        )
        do {
            sessions = try modelContext.fetch(descriptor)
            NSLog("[SessionList] loadSessions: fetched %d sessions from DB", sessions.count)
            applySearch()
        } catch {
            NSLog("[SessionList] loadSessions: fetch failed: %@", String(describing: error))
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
        guard let modelContext else {
            // modelContext not yet set (onAppear hasn't fired); buffer and retry
            NSLog("[SessionList] handleSessionSync: modelContext nil — buffering %d sessions", response.sessions.count)
            pendingSessionResponse = response
            return
        }
        NSLog("[SessionList] handleSessionSync: processing %d sessions, in-memory sessions=%d", response.sessions.count, sessions.count)
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
        do {
            try modelContext.save()
        } catch {
            NSLog("[SessionList] save failed: %@", String(describing: error))
        }

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
        guard let modelContext else {
            NSLog("[SessionList] loadSessionsFromDB: modelContext nil")
            return
        }
        let descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageTime, order: .reverse)]
        )
        do {
            sessions = try modelContext.fetch(descriptor)
            NSLog("[SessionList] loadSessionsFromDB: fetched %d sessions", sessions.count)
        } catch {
            NSLog("[SessionList] loadSessionsFromDB: fetch failed: %@", String(describing: error))
            sessions = []
        }
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

    // MARK: - Grouping

    struct SessionGroup: Identifiable {
        let id: String
        let title: String
        let sessions: [Session]
    }

    var groupedFilteredSessions: [SessionGroup] {
        let cal = Calendar.current
        let now = Date()
        let startOfToday = cal.startOfDay(for: now)
        let start7 = cal.date(byAdding: .day, value: -7, to: startOfToday)!
        let start30 = cal.date(byAdding: .day, value: -30, to: startOfToday)!
        let currentYear = cal.component(.year, from: now)

        var order: [String] = []
        var grouped: [String: [Session]] = [:]

        for session in filteredSessions {
            let d = session.lastMessageTime
            let key: String
            if d >= startOfToday {
                key = "今天"
            } else if d >= start7 {
                key = "过去 7 天"
            } else if d >= start30 {
                key = "过去 30 天"
            } else {
                let y = cal.component(.year, from: d)
                let m = cal.component(.month, from: d)
                if y == currentYear {
                    key = Self.chineseMonth(m)
                } else {
                    key = "\(y)年"
                }
            }
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(session)
        }

        return order.map { SessionGroup(id: $0, title: $0, sessions: grouped[$0]!) }
    }

    private static func chineseMonth(_ month: Int) -> String {
        let names = ["一月","二月","三月","四月","五月","六月",
                     "七月","八月","九月","十月","十一月","十二月"]
        guard month >= 1, month <= 12 else { return "\(month)月" }
        return names[month - 1]
    }

    // MARK: - Formatting

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f
    }()

    func relativeTime(for date: Date) -> String {
        Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
