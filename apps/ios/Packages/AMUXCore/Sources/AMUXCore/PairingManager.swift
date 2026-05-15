import Foundation
import Observation

@Observable
public final class PairingManager {
    public private(set) var isPaired: Bool = false
    public private(set) var brokerHost: String = ""
    public private(set) var brokerPort: Int = 8883
    public private(set) var authToken: String = ""
    public private(set) var useTLS: Bool = true

    private let store: CredentialStore

    public init(store: CredentialStore = UserDefaultsCredentialStore()) {
        self.store = store
        loadFromStore()
        if brokerHost.isEmpty {
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
        try store.save(currentCredentials())
    }

    public func unpair() throws {
        isPaired = false
        brokerHost = ""
        brokerPort = 8883
        authToken = ""
        useTLS = true
        try store.clear()
    }

    private func applyDefaults() {
        let defaults = PairingCredentials(
            brokerHost: "ai.ucar.cc",
            brokerPort: 8883,
            useTLS: true,
            authToken: authToken
        )
        try? store.save(defaults)
        apply(defaults)
    }

    private func apply(_ c: PairingCredentials) {
        brokerHost = c.brokerHost
        brokerPort = c.brokerPort
        useTLS = c.useTLS
        authToken = c.authToken
        isPaired = !c.brokerHost.isEmpty
    }

    private func currentCredentials() -> PairingCredentials {
        PairingCredentials(
            brokerHost: brokerHost,
            brokerPort: brokerPort,
            useTLS: useTLS,
            authToken: authToken
        )
    }

    private func loadFromStore() {
        if let c = try? store.load() {
            apply(c)
        }
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
            authToken: token
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
