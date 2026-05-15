import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI
import Sentry

@main
struct AMUXApp: App {
    @State private var pairing = PairingManager()
    let modelContainer: ModelContainer

    init() {
        SentrySDK.start { options in
            options.dsn = "https://7551f3236520b84b27ec473a1d7c1480@o60909.ingest.us.sentry.io/4511233545011200"
            options.tracesSampleRate = 0.2
            options.enableAutoPerformanceTracing = true
            options.enableUIViewControllerTracing = true
            options.enableSwizzling = true
            // Sentry's Core Data swizzling spams "saveSpan is nil" once per
            // SwiftData save (every event the chat view streams). Disable it —
            // we don't have any direct Core Data usage to observe anyway.
            options.enableCoreDataTracing = false
            options.attachScreenshot = true
            options.attachViewHierarchy = true
            #if DEBUG
            options.debug = true
            options.environment = "development"
            #else
            options.environment = "production"
            #endif
        }

        // Explicit VersionedSchema + migration plan so SwiftData never falls
        // back to destructive migration on a field-shape change. See
        // AMUXSchema.swift for the upgrade checklist when models evolve.
        do {
            modelContainer = try AMUXModelContainerFactory.make()
        } catch {
            fatalError("Failed to initialise ModelContainer: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView(pairing: pairing)
                .onOpenURL { url in handle(url) }
                // App-wide tint flips iOS 26 glass buttons, tab-bar selection,
                // toggle accents, and other system tinted surfaces to the Hai
                // Cinnabar accent without disturbing liquid-glass behaviour.
                .tint(Color.amux.cinnabar)
        }
        .modelContainer(modelContainer)
    }

    private func handle(_ url: URL) {
        guard let scheme = url.scheme, ["teamclaw", "amux"].contains(scheme) else { return }

        switch url.host {
        case "invite":
            guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = comps.queryItems?.first(where: { $0.name == "token" })?.value
            else { return }
            NotificationCenter.default.post(
                name: .amuxInviteTokenReceived, object: nil, userInfo: ["token": token]
            )
        case "auth-callback":
            NotificationCenter.default.post(
                name: .amuxAuthCallbackReceived, object: url
            )
        default:
            break
        }
    }
}
