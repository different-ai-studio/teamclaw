import Combine
import Foundation
import SwiftData

@MainActor
final class TalentViewModel: ObservableObject {

    @Published var talents: [Talent] = []
    @Published private(set) var isDesktopOnline: Bool = false

    private let modelContext: ModelContext
    private let mqttService: MQTTServiceProtocol
    private var cancellables = Set<AnyCancellable>()

    /// IDs received across all pages of the current sync cycle.
    private var receivedIDs: Set<String> = []

    init(modelContext: ModelContext, mqttService: MQTTServiceProtocol) {
        self.modelContext = modelContext
        self.mqttService = mqttService
        subscribeToMQTT()
        subscribeToStatus()
    }

    func loadTalents() {
        guard isDesktopOnline else { return }
        requestTalents(page: 1)
    }

    func requestTalents(page: Int = 1) {
        guard let creds = PairingManager.currentCredentials else { return }
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

        // Don't wipe cache when server returns empty
        guard !response.talents.isEmpty || pg.total > 0 else { return }

        let isFirstPage = pg.page <= 1
        if isFirstPage { receivedIDs.removeAll() }

        // Upsert: @Attribute(.unique) on id makes insert act as upsert
        for data in response.talents {
            receivedIDs.insert(data.id)
            let talent = Talent(
                id: data.id,
                name: data.name,
                talentDescription: data.description_p,
                category: data.category,
                icon: data.hasIcon ? data.icon : "cpu",
                downloads: Int(data.downloads),
                role: data.role,
                whenToUse: data.whenToUse,
                workingStyle: data.workingStyle
            )
            modelContext.insert(talent)
        }

        let hasMore = pg.total > pg.page * pg.pageSize
        if hasMore {
            requestTalents(page: Int(pg.page) + 1)
        } else {
            // Remove stale talents not present in this sync cycle
            let descriptor = FetchDescriptor<Talent>()
            if let existing = try? modelContext.fetch(descriptor) {
                for talent in existing where !receivedIDs.contains(talent.id) {
                    modelContext.delete(talent)
                }
            }
            try? modelContext.save()
            loadTalentsFromDB()
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

    private func loadTalentsFromDB() {
        let descriptor = FetchDescriptor<Talent>(sortBy: [SortDescriptor(\.name)])
        talents = (try? modelContext.fetch(descriptor)) ?? []
    }
}
