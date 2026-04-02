import SwiftUI
import SwiftData

@main
struct TeamClawMobileApp: App {
    @StateObject private var pairingManager = PairingManager()

    var body: some Scene {
        WindowGroup {
            ContentView(pairingManager: pairingManager)
        }
        .modelContainer(for: [
            Session.self,
            ChatMessage.self,
            TeamMember.self,
            AutomationTask.self,
            Skill.self
        ])
    }
}
