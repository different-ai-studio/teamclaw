import Combine
import Foundation
import SwiftData

@MainActor
final class MemberViewModel: ObservableObject {

    @Published var members: [TeamMember] = []
    @Published private(set) var isDesktopOnline: Bool = false

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
        subscribeToStatus()
        loadMembersFromDB()
    }

    func loadMembers() {
        guard isDesktopOnline else { return }
        requestMembers(page: 1)
    }

    func requestMembers(page: Int = 1) {
        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_MemberSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = Int32(page)
        pg.pageSize = 50
        req.pagination = pg
        let msg = ProtoMQTTCoder.makeEnvelope(.memberSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    func collaborativeSessions(for member: TeamMember) -> [Session] {
        let descriptor = FetchDescriptor<Session>()
        guard let allSessions = try? modelContext.fetch(descriptor) else { return [] }
        return allSessions.filter { $0.isCollaborative && $0.collaboratorIDs.contains(member.id) }
    }

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_MemberSyncResponse? in
                if case .memberSyncResponse(let resp) = msg.payload { return resp }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] response in
                self?.handleMemberSync(response)
            }
            .store(in: &cancellables)
    }

    /// IDs received across all pages of the current sync cycle.
    private var receivedIDs: Set<String> = []

    private func handleMemberSync(_ response: Teamclaw_MemberSyncResponse) {
        let pg = response.pagination

        // Don't wipe cached members when server returns empty first page
        guard !response.members.isEmpty || pg.total > 0 else { return }

        let isFirstPage = pg.page <= 1
        if isFirstPage { receivedIDs.removeAll() }

        // Upsert: @Attribute(.unique) on id makes insert act as upsert
        for data in response.members {
            receivedIDs.insert(data.id)
            let member = TeamMember(
                id: data.id,
                name: data.name,
                avatarURL: data.avatarURL,
                department: data.hasDepartment ? data.department : "",
                isAIAlly: data.isAiAlly,
                note: data.note
            )
            modelContext.insert(member)
        }

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestMembers(page: Int(pg.page) + 1)
        } else {
            // Remove stale members not present in this sync cycle
            let descriptor = FetchDescriptor<TeamMember>()
            if let existing = try? modelContext.fetch(descriptor) {
                for member in existing where !receivedIDs.contains(member.id) {
                    modelContext.delete(member)
                }
            }
            try? modelContext.save()
            loadMembersFromDB()
        }
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
            }
            .store(in: &cancellables)
    }

    private func loadMembersFromDB() {
        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
        members = (try? modelContext.fetch(descriptor)) ?? []
    }
}
