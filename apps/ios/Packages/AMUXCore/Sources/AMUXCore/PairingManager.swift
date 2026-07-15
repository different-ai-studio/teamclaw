import Foundation
import Observation

@Observable
public final class PairingManager {
    public private(set) var isPaired: Bool = false
    public private(set) var brokerHost: String = ""
    public private(set) var brokerPort: Int = SharedDefaults.services.mqttPort
    public private(set) var authToken: String = ""
    public private(set) var useTLS: Bool = SharedDefaults.services.mqttUseTls
    private var userOverride: Bool = false

    private let store: CredentialStore

    public init(store: CredentialStore = UserDefaultsCredentialStore()) {
        self.store = store
        // Honour a stored broker host ONLY when the user explicitly set it.
        // Otherwise always (re-)apply the bundled default, so a changed default
        // propagates across app updates instead of being shadowed by a host an
        // older build auto-persisted.
        if let c = try? store.load(), c.userOverride {
            apply(c)
        } else {
            applyDefaults()
        }
    }

    /// Legacy MQTT pairing deeplink flow. iOS no longer invokes this — use
    /// `updateMQTTServer(...)` via Settings instead. Kept for the macOS shell
    /// which still presents a paste-a-deeplink UI.
    public func pair(from url: URL) throws {
        let credentials = try Self.parse(url: url)
        try store.save(credentials)
        apply(credentials)
    }

    public func updateMQTTServer(host: String) throws {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        self.brokerHost = trimmedHost
        self.isPaired = !trimmedHost.isEmpty
        // An explicit Settings change is a user override — it must survive
        // future bundled-default changes.
        self.userOverride = true
        try store.save(currentCredentials())
    }

    public func unpair() throws {
        isPaired = false
        brokerHost = ""
        brokerPort = SharedDefaults.services.mqttPort
        authToken = ""
        useTLS = SharedDefaults.services.mqttUseTls
        userOverride = false
        try store.clear()
    }

    private func applyDefaults() {
        let services = SharedDefaults.services
        let defaults = PairingCredentials(
            brokerHost: services.mqttHost,
            brokerPort: services.mqttPort,
            useTLS: services.mqttUseTls,
            authToken: authToken,
            userOverride: false
        )
        try? store.save(defaults)
        apply(defaults)
    }

    private func apply(_ c: PairingCredentials) {
        brokerHost = c.brokerHost
        brokerPort = c.brokerPort
        useTLS = c.useTLS
        authToken = c.authToken
        userOverride = c.userOverride
        isPaired = !c.brokerHost.isEmpty
    }

    private func currentCredentials() -> PairingCredentials {
        PairingCredentials(
            brokerHost: brokerHost,
            brokerPort: brokerPort,
            useTLS: useTLS,
            authToken: authToken,
            userOverride: userOverride
        )
    }

    public static func parse(url: URL) throws -> PairingCredentials {
        guard let scheme = url.scheme, ["teamclaw", "amux"].contains(scheme), url.host == "join" else {
            throw PairingError.invalidURL
        }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems else {
            throw PairingError.invalidURL
        }
        let params = Dictionary(uniqueKeysWithValues: items.compactMap { item in
            item.value.map { (item.name, $0.filter { !$0.isWhitespace && !$0.isNewline }) }
        })
        guard let broker = params["broker"],
              let token = params["token"] else {
            throw PairingError.missingFields
        }
        let tls = broker.hasPrefix("mqtts://")
        let hostPart = broker
            .replacingOccurrences(of: "mqtts://", with: "")
            .replacingOccurrences(of: "mqtt://", with: "")
        let parts = hostPart.split(separator: ":")
        let host = String(parts[0])
        let defaultPort = tls ? 8883 : 1883
        let port = parts.count > 1 ? Int(parts[1]) ?? defaultPort : defaultPort
        return PairingCredentials(
            brokerHost: host,
            brokerPort: port,
            useTLS: tls,
            authToken: token,
            // An explicit pairing deeplink is a user-chosen broker.
            userOverride: true
        )
    }

    public enum PairingError: Error, LocalizedError {
        case invalidURL
        case missingFields

        public var errorDescription: String? {
            switch self {
            case .invalidURL: "Invalid pairing URL"
            case .missingFields: "Missing broker or token in URL"
            }
        }
    }
}
