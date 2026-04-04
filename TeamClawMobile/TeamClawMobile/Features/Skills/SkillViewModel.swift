import Combine
import Foundation
import SwiftData

@MainActor
final class SkillViewModel: ObservableObject {

    @Published var personalSkills: [Skill] = []
    @Published var teamSkills: [Skill] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    func loadSkills() {
        loadSkillsFromDB()
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
        let pg = response.pagination
        let isFirstPage = pg.page <= 1

        if isFirstPage {
            let descriptor = FetchDescriptor<Skill>()
            if let existing = try? modelContext.fetch(descriptor) {
                for skill in existing { modelContext.delete(skill) }
            }
        }

        for data in response.skills {
            let skill = Skill(
                id: data.id,
                name: data.name,
                skillDescription: data.description_p,
                isPersonal: data.isPersonal,
                isEnabled: data.isEnabled
            )
            modelContext.insert(skill)
        }

        try? modelContext.save()

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestSkills(page: Int(pg.page) + 1)
        } else {
            loadSkillsFromDB()
        }
    }

    private func loadSkillsFromDB() {
        let descriptor = FetchDescriptor<Skill>(sortBy: [SortDescriptor(\.name)])
        let allSkills = (try? modelContext.fetch(descriptor)) ?? []
        personalSkills = allSkills.filter(\.isPersonal)
        teamSkills = allSkills.filter { !$0.isPersonal }
    }
}
