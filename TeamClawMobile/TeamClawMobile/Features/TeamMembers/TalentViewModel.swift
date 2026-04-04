import Combine
import Foundation
import SwiftData

@MainActor
final class TalentViewModel: ObservableObject {

    @Published var talents: [Talent] = []

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
    }

    func loadTalents() {
        loadTalentsFromDB()
        requestTalents(page: 1)
    }

    func requestTalents(page: Int = 1) {
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        var req = Teamclaw_TalentSyncRequest()
        var pg = Teamclaw_PageRequest()
        pg.page = Int32(page)
        pg.pageSize = 50
        req.pagination = pg
        let msg = ProtoMQTTCoder.makeEnvelope(.talentSyncRequest(req))
        mqttService.publish(topic: topic, message: msg, qos: 1)
    }

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { msg -> Teamclaw_TalentSyncResponse? in
                if case .talentSyncResponse(let resp) = msg.payload { return resp }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] response in
                self?.handleTalentSync(response)
            }
            .store(in: &cancellables)
    }

    private func handleTalentSync(_ response: Teamclaw_TalentSyncResponse) {
        let pg = response.pagination
        let isFirstPage = pg.page <= 1

        if isFirstPage {
            let descriptor = FetchDescriptor<Talent>()
            if let existing = try? modelContext.fetch(descriptor) {
                for talent in existing { modelContext.delete(talent) }
            }
        }

        for data in response.talents {
            let talent = Talent(
                id: data.id,
                name: data.name,
                talentDescription: data.description_p,
                category: data.category,
                icon: data.hasIcon ? data.icon : "cpu",
                downloads: Int(data.downloads)
            )
            modelContext.insert(talent)
        }

        try? modelContext.save()

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestTalents(page: Int(pg.page) + 1)
        } else {
            loadTalentsFromDB()
        }
    }

    private func loadTalentsFromDB() {
        let descriptor = FetchDescriptor<Talent>(sortBy: [SortDescriptor(\.name)])
        talents = (try? modelContext.fetch(descriptor)) ?? []
    }
}
