import Combine
import Foundation
import SwiftData

@MainActor
final class TalentViewModel: ObservableObject {

    // MARK: - Published Properties

    @Published var talents: [Talent] = []

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

    func loadTalents() {
        loadTalentsFromDB()
        requestTalents()
    }

    func requestTalents() {
        guard let creds = PairingManager().credentials else { return }
        let topic = "teamclaw/\(creds.teamID)/\(creds.deviceID)/chat/req"
        mqttService.publishRaw(topic: topic, payload: "/talents", qos: 1)
    }

    // MARK: - Private Methods

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { message -> TalentSyncPayload? in
                if case .talentSync(let payload) = message.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleTalentSync(payload)
            }
            .store(in: &cancellables)
    }

    private func handleTalentSync(_ payload: TalentSyncPayload) {
        let descriptor = FetchDescriptor<Talent>()
        if let existing = try? modelContext.fetch(descriptor) {
            for talent in existing {
                modelContext.delete(talent)
            }
        }

        for data in payload.talents {
            let talent = Talent(
                id: data.id,
                name: data.name,
                talentDescription: data.description,
                category: data.category,
                icon: data.icon ?? "cpu",
                downloads: data.downloads ?? 0
            )
            modelContext.insert(talent)
        }

        try? modelContext.save()
        loadTalentsFromDB()
    }

    private func loadTalentsFromDB() {
        let descriptor = FetchDescriptor<Talent>(
            sortBy: [SortDescriptor(\.name)]
        )
        talents = (try? modelContext.fetch(descriptor)) ?? []
    }
}
