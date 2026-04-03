import Combine
import Foundation
import SwiftData

@MainActor
final class MemberViewModel: ObservableObject {

    // MARK: - Published Properties

    @Published var members: [TeamMember] = []

    // MARK: - Private

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Init

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    // MARK: - Public Methods

    func loadMembers() {
        loadMembersFromDB()
        requestMembers()
    }

    func requestMembers() {
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        mqttService.publishRaw(topic: topic, payload: "/members", qos: 1)
    }

    func collaborativeSessions(for member: TeamMember) -> [Session] {
        let descriptor = FetchDescriptor<Session>()
        guard let allSessions = try? modelContext.fetch(descriptor) else { return [] }
        return allSessions.filter { $0.isCollaborative && $0.collaboratorIDs.contains(member.id) }
    }

    // MARK: - Private Methods

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { message -> MemberSyncPayload? in
                if case .memberSync(let payload) = message.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleMemberSync(payload)
            }
            .store(in: &cancellables)
    }

    private func handleMemberSync(_ payload: MemberSyncPayload) {
        // Delete all existing members
        let descriptor = FetchDescriptor<TeamMember>()
        if let existing = try? modelContext.fetch(descriptor) {
            for member in existing {
                modelContext.delete(member)
            }
        }

        // Insert new members from payload
        for data in payload.members {
            let member = TeamMember(
                id: data.id,
                name: data.name,
                avatarURL: data.avatarURL,
                department: data.department ?? "",
                isAIAlly: data.isAIAlly ?? false,
                note: data.note
            )
            modelContext.insert(member)
        }

        try? modelContext.save()
        loadMembersFromDB()
    }

    private func loadMembersFromDB() {
        let descriptor = FetchDescriptor<TeamMember>(
            sortBy: [SortDescriptor(\.name)]
        )
        members = (try? modelContext.fetch(descriptor)) ?? []
    }
}
