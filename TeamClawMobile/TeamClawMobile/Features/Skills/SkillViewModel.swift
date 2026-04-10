import Combine
import Foundation
import SwiftData

@MainActor
final class SkillViewModel: ObservableObject {

    @Published var personalSkills: [Skill] = []
    @Published var teamSkills: [Skill] = []
    @Published private(set) var isDesktopOnline: Bool = false

    private var modelContext: ModelContext?
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    /// IDs received across all pages of the current sync cycle.
    private var receivedIDs: Set<String> = []

    func setModelContext(_ context: ModelContext) {
        guard modelContext == nil else { return }
        modelContext = context
        loadSkillsFromDB()
    }

    init(mqttService: MQTTServiceProtocol) {
        self.mqttService = mqttService
        subscribeToMQTT()
        subscribeToStatus()
    }

    func loadSkills() {
        guard isDesktopOnline else { return }
        requestSkills(page: 1)
    }

    func requestSkills(page: Int = 1) {
        guard let creds = PairingManager.currentCredentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_SkillSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = Int32(page)
        pg.pageSize = 50
        req.pagination = pg
        let msg = ProtoMQTTCoder.makeEnvelope(.skillSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_SkillSyncResponse? in
                if case .skillSyncResponse(let resp) = msg.payload { return resp }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] response in
                self?.handleSkillSync(response)
            }
            .store(in: &cancellables)
    }

    private func handleSkillSync(_ response: Teamclaw_SkillSyncResponse) {
        guard let modelContext else { return }
        let pg = response.pagination

        // Don't wipe cache when server returns empty
        guard !response.skills.isEmpty || pg.total > 0 else { return }

        let isFirstPage = pg.page <= 1
        if isFirstPage { receivedIDs.removeAll() }

        // Upsert: @Attribute(.unique) on id makes insert act as upsert
        for data in response.skills {
            receivedIDs.insert(data.id)
            let skill = Skill(
                id: data.id,
                name: data.name,
                skillDescription: data.description_p,
                isPersonal: data.isPersonal,
                isEnabled: data.isEnabled
            )
            modelContext.insert(skill)
        }

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestSkills(page: Int(pg.page) + 1)
        } else {
            // Remove stale skills not present in this sync cycle
            let descriptor = FetchDescriptor<Skill>()
            if let existing = try? modelContext.fetch(descriptor) {
                for skill in existing where !receivedIDs.contains(skill.id) {
                    modelContext.delete(skill)
                }
            }
            try? modelContext.save()
            loadSkillsFromDB()
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

    private func loadSkillsFromDB() {
        guard let modelContext else { return }
        let descriptor = FetchDescriptor<Skill>(sortBy: [SortDescriptor(\.name)])
        let allSkills = (try? modelContext.fetch(descriptor)) ?? []
        personalSkills = allSkills.filter(\.isPersonal)
        teamSkills = allSkills.filter { !$0.isPersonal }
    }
}
