import Combine
import Foundation
import SwiftData

@MainActor
final class SkillViewModel: ObservableObject {

    // MARK: - Published Properties

    @Published var personalSkills: [Skill] = []
    @Published var teamSkills: [Skill] = []

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

    func loadSkills() {
        let descriptor = FetchDescriptor<Skill>(
            sortBy: [SortDescriptor(\.name)]
        )
        let allSkills = (try? modelContext.fetch(descriptor)) ?? []
        personalSkills = allSkills.filter(\.isPersonal)
        teamSkills = allSkills.filter { !$0.isPersonal }
    }

    // MARK: - Private Methods

    private func subscribeToMQTT() {
        mqttService.receivedMessage
            .compactMap { message -> SkillSyncPayload? in
                if case .skillSync(let payload) = message.payload {
                    return payload
                }
                return nil
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in
                self?.handleSkillSync(payload)
            }
            .store(in: &cancellables)
    }

    private func handleSkillSync(_ payload: SkillSyncPayload) {
        // Delete all existing skills
        let descriptor = FetchDescriptor<Skill>()
        if let existing = try? modelContext.fetch(descriptor) {
            for skill in existing {
                modelContext.delete(skill)
            }
        }

        // Insert new skills from payload
        for data in payload.skills {
            let skill = Skill(
                id: data.id,
                name: data.name,
                skillDescription: data.description,
                isPersonal: data.isPersonal,
                isEnabled: data.isEnabled
            )
            modelContext.insert(skill)
        }

        try? modelContext.save()
        loadSkills()
    }
}
