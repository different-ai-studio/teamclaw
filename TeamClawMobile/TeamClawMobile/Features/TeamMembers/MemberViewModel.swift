import Combine
import Foundation
import SwiftData

@MainActor
final class MemberViewModel: ObservableObject {

    @Published var members: [TeamMember] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    func loadMembers() {
        loadMembersFromDB()
        requestMembers(page: 1)
    }

    func requestMembers(page: Int = 1) {
        guard let creds = PairingManager().credentials else { return }
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

    private func handleMemberSync(_ response: Teamclaw_MemberSyncResponse) {
        let pg = response.pagination
        let isFirstPage = pg.page <= 1

        if isFirstPage {
            let descriptor = FetchDescriptor<TeamMember>()
            if let existing = try? modelContext.fetch(descriptor) {
                for member in existing { modelContext.delete(member) }
            }
        }

        for data in response.members {
            let member = TeamMember(
                id: data.id,
                name: data.name,
                avatarURL: data.avatarUrl,
                department: data.hasDepartment ? data.department : "",
                isAIAlly: data.isAiAlly,
                note: data.note
            )
            modelContext.insert(member)
        }

        try? modelContext.save()

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestMembers(page: Int(pg.page) + 1)
        } else {
            loadMembersFromDB()
        }
    }

    private func loadMembersFromDB() {
        let descriptor = FetchDescriptor<TeamMember>(sortBy: [SortDescriptor(\.name)])
        members = (try? modelContext.fetch(descriptor)) ?? []
    }
}
