import Foundation
import UIKit
import AMUXCore

@MainActor
final class PushBootstrap {
    static let shared = PushBootstrap()

    private(set) var service: PushService?
    private(set) var heartbeat: PresenceHeartbeat?
    private(set) var preferencesAPI: PushPreferencesAPI?

    func register(uploader: PushTokenUploader,
                  presenceWriter: PresenceWriter,
                  preferencesAPI: PushPreferencesAPI,
                  userIDProvider: @escaping @Sendable () -> String?) {
        let bundle = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let deviceID = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        service = PushService(
            uploader: uploader,
            userIDProvider: userIDProvider,
            deviceIDProvider: { [deviceID] in deviceID },
            appVersionProvider: { [bundle] in bundle }
        )
        heartbeat = PresenceHeartbeat(writer: presenceWriter, deviceID: deviceID)
        self.preferencesAPI = preferencesAPI
    }

    func handleApnsToken(_ hex: String) async {
        guard let svc = service else { return }
        try? await svc.uploadToken(hex)
    }

    /// Convenience: build all three Cloud-API-backed adapters and register
    /// them. Identity is derived server-side from the bearer token, so the
    /// only thing the uploader needs locally is whether a session exists
    /// (to gate token upload before sign-in).
    func registerWithCloudAPI(client: CloudAPIClient,
                              isAuthenticated: @escaping @Sendable () -> Bool) {
        let uploader = CloudAPIPushTokenUploader(client: client)
        let presence = CloudAPIPresenceWriter(client: client)
        let prefs = CloudAPIPushPreferences(client: client)
        register(uploader: uploader, presenceWriter: presence,
                 preferencesAPI: prefs,
                 userIDProvider: { isAuthenticated() ? "self" : nil })
    }
}
