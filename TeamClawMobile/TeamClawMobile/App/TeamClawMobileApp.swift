import SwiftUI
import SwiftData

@main
struct TeamClawMobileApp: App {
    @StateObject private var pairingManager = PairingManager()

    private static let appContainer: ModelContainer = {
        let schema = Schema([
            Session.self,
            ChatMessage.self,
            TeamMember.self,
            AutomationTask.self,
            Skill.self,
            Talent.self
        ])
        do {
            return try ModelContainer(for: schema)
        } catch {
            // Migration failed (e.g., schema changed between builds).
            // All data is server-synced, so it's safe to wipe the local store.
            NSLog("[App] ModelContainer creation failed (%@) — deleting store and recreating", String(describing: error))
            let config = ModelConfiguration(schema: schema)
            let storeURL = config.url
            let fm = FileManager.default
            for suffix in ["", "-wal", "-shm"] {
                try? fm.removeItem(at: URL(fileURLWithPath: storeURL.path + suffix))
            }
            return try! ModelContainer(for: schema)
        }
    }()

    var body: some Scene {
        WindowGroup {
            ContentView(pairingManager: pairingManager)
        }
        .modelContainer(Self.appContainer)
    }
}
