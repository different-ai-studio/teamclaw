import Foundation

public struct PairingCredentials: Equatable, Sendable {
    public var brokerHost: String
    public var brokerPort: Int
    public var useTLS: Bool
    public var authToken: String

    public init(
        brokerHost: String,
        brokerPort: Int,
        useTLS: Bool,
        authToken: String
    ) {
        self.brokerHost = brokerHost
        self.brokerPort = brokerPort
        self.useTLS = useTLS
        self.authToken = authToken
    }
}

public protocol CredentialStore: AnyObject, Sendable {
    func save(_ credentials: PairingCredentials) throws
    func load() throws -> PairingCredentials?
    func clear() throws
}

// @unchecked Sendable is safe: UserDefaults is documented as thread-safe by Apple.
public final class UserDefaultsCredentialStore: CredentialStore, @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func save(_ c: PairingCredentials) throws {
        defaults.set(c.brokerHost, forKey: Keys.brokerHost)
        defaults.set(c.brokerPort, forKey: Keys.brokerPort)
        defaults.set(c.authToken, forKey: Keys.authToken)
        defaults.set(c.useTLS, forKey: Keys.useTLS)
    }

    public func load() throws -> PairingCredentials? {
        guard let host = string(forKey: Keys.brokerHost, legacyKey: LegacyKeys.brokerHost),
              !host.isEmpty else {
            return nil
        }
        var port = integer(forKey: Keys.brokerPort, legacyKey: LegacyKeys.brokerPort)
        if port == 0 { port = 8883 }
        return PairingCredentials(
            brokerHost: host,
            brokerPort: port,
            useTLS: bool(forKey: Keys.useTLS, legacyKey: LegacyKeys.useTLS),
            authToken: string(forKey: Keys.authToken, legacyKey: LegacyKeys.authToken) ?? ""
        )
    }

    public func clear() throws {
        for key in Keys.all { defaults.removeObject(forKey: key) }
        for key in LegacyKeys.all { defaults.removeObject(forKey: key) }
        // Also remove the legacy device-id key written by older builds, so a
        // clean unpair doesn't leave stale routing state on disk.
        defaults.removeObject(forKey: "teamclaw_device_id")
        defaults.removeObject(forKey: LegacyKeys.deviceID)
    }

    private func string(forKey key: String, legacyKey: String) -> String? {
        defaults.string(forKey: key) ?? defaults.string(forKey: legacyKey)
    }

    private func integer(forKey key: String, legacyKey: String) -> Int {
        if defaults.object(forKey: key) != nil { return defaults.integer(forKey: key) }
        return defaults.integer(forKey: legacyKey)
    }

    private func bool(forKey key: String, legacyKey: String) -> Bool {
        if defaults.object(forKey: key) != nil { return defaults.bool(forKey: key) }
        return defaults.bool(forKey: legacyKey)
    }

    private enum Keys {
        static let brokerHost = "teamclaw_broker_host"
        static let brokerPort = "teamclaw_broker_port"
        static let authToken  = "teamclaw_auth_token"
        static let useTLS     = "teamclaw_use_tls"
        static let all = [brokerHost, brokerPort, authToken, useTLS]
    }

    private enum LegacyKeys {
        static let brokerHost = "amux_broker_host"
        static let brokerPort = "amux_broker_port"
        static let authToken  = "amux_auth_token"
        static let useTLS     = "amux_use_tls"
        static let deviceID   = "amux_device_id"
        static let all = [brokerHost, brokerPort, authToken, useTLS, deviceID]
    }
}
