import Testing
import Foundation
@testable import AMUXCore

@Suite("PairingManager")
struct PairingManagerTests {

    // Single-threaded test double; CredentialStore is Sendable but this needs
    // mutable storage, so vouch for it under Swift 6 strict concurrency.
    final class InMemoryStore: CredentialStore, @unchecked Sendable {
        var saved: PairingCredentials?
        func save(_ credentials: PairingCredentials) throws { saved = credentials }
        func load() throws -> PairingCredentials? { saved }
        func clear() throws { saved = nil }
    }

    // Keeps the server-handed broker address out of the shared UserDefaults so
    // tests don't leak state into each other (or into the simulator).
    final class InMemoryBrokerCache: BrokerConfigCache, @unchecked Sendable {
        var endpoint: MQTTEndpoint?
        init(_ endpoint: MQTTEndpoint? = nil) { self.endpoint = endpoint }
        func save(_ endpoint: MQTTEndpoint) { self.endpoint = endpoint }
        func load() -> MQTTEndpoint? { endpoint }
        func clear() { endpoint = nil }
    }

    private func makeManager(
        store: CredentialStore,
        cache: BrokerConfigCache = InMemoryBrokerCache()
    ) -> PairingManager {
        PairingManager(store: store, brokerCache: cache)
    }

    @Test("pairs from a valid teamclu:// URL with mqtts broker")
    func pairsFromValidURL() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)

        let url = URL(string: "teamclu://join?broker=mqtts://broker.example.com:8883&device=mac-1&token=tok-abc")!
        try manager.pair(from: url)

        #expect(manager.isPaired)
        #expect(manager.brokerHost == "broker.example.com")
        #expect(manager.brokerPort == 8883)
        #expect(manager.authToken == "tok-abc")
        #expect(manager.useTLS == true)
        #expect(store.saved?.authToken == "tok-abc")
    }

    @Test("accepts legacy amux:// URL with mqtts broker")
    func pairsFromLegacyAMUXURL() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)

        let url = URL(string: "amux://join?broker=mqtts://broker.example.com:8883&device=mac-1&token=tok-abc")!
        try manager.pair(from: url)

        #expect(manager.isPaired)
        #expect(manager.brokerHost == "broker.example.com")
        #expect(manager.brokerPort == 8883)
        #expect(manager.authToken == "tok-abc")
        #expect(manager.useTLS == true)
        #expect(store.saved?.authToken == "tok-abc")
    }

    @Test("defaults port 8883 for mqtts when not specified")
    func defaultsPortForMqtts() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)
        let url = URL(string: "teamclu://join?broker=mqtts://broker.example.com&device=d&token=t")!
        try manager.pair(from: url)
        #expect(manager.brokerPort == 8883)
        #expect(manager.useTLS == true)
    }

    @Test("defaults port 1883 for mqtt:// (non-TLS)")
    func defaultsPortForMqttPlain() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)
        let url = URL(string: "teamclu://join?broker=mqtt://broker.example.com&device=d&token=t")!
        try manager.pair(from: url)
        #expect(manager.brokerPort == 1883)
        #expect(manager.useTLS == false)
    }

    @Test("rejects URLs with wrong scheme")
    func rejectsWrongScheme() {
        let manager = PairingManager(store: InMemoryStore())
        let url = URL(string: "https://join?broker=mqtts://x&device=d&token=t")!
        #expect(throws: PairingManager.PairingError.self) {
            try manager.pair(from: url)
        }
    }

    @Test("rejects URLs missing required fields")
    func rejectsMissingFields() {
        let manager = PairingManager(store: InMemoryStore())
        let url = URL(string: "teamclu://join?device=d&token=t")!  // no broker
        #expect(throws: PairingManager.PairingError.self) {
            try manager.pair(from: url)
        }
    }

    @Test("loads previously stored credentials on init when user-overridden")
    func loadsStoredCredentialsOnInit() throws {
        let store = InMemoryStore()
        store.saved = PairingCredentials(
            brokerHost: "h", brokerPort: 8883, useTLS: true,
            authToken: "t", userOverride: true
        )
        let manager = PairingManager(store: store)
        #expect(manager.isPaired)
        #expect(manager.brokerHost == "h")
        #expect(manager.authToken == "t")
    }

    @Test("ignores an auto-applied stored host and re-applies the cached server address")
    func ignoresStaleAutoDefaultOnInit() throws {
        let store = InMemoryStore()
        // Host persisted by an older build (no user override) must NOT win over
        // the address the Cloud API last handed out.
        store.saved = PairingCredentials(
            brokerHost: "stale.example.com", brokerPort: 1883, useTLS: false,
            authToken: "", userOverride: false
        )
        let cache = InMemoryBrokerCache(
            MQTTEndpoint(host: "broker.from-server", port: 8883, useTLS: true)
        )
        let manager = makeManager(store: store, cache: cache)
        #expect(manager.brokerHost == "broker.from-server")
        #expect(manager.brokerPort == 8883)
        #expect(manager.useTLS)
    }

    @Test("stays unpaired when nothing has been handed out yet")
    func staysUnpairedWithoutServerConfig() throws {
        let store = InMemoryStore()
        store.saved = PairingCredentials(
            brokerHost: "stale.example.com", brokerPort: 1883, useTLS: false,
            authToken: "", userOverride: false
        )
        let manager = makeManager(store: store)
        // No bundled host to fall back on — a baked-in address outlives the
        // server it points at, which is exactly the bug this replaces.
        #expect(manager.brokerHost == "")
        #expect(!manager.isPaired)
    }

    @Test("adopts the server broker address and caches it")
    func adoptsServerBrokerConfig() throws {
        let store = InMemoryStore()
        let cache = InMemoryBrokerCache()
        let manager = makeManager(store: store, cache: cache)

        manager.applyServerBrokerConfig(
            MQTTEndpoint(host: "broker.example.com", port: 8883, useTLS: true)
        )

        #expect(manager.brokerHost == "broker.example.com")
        #expect(manager.brokerPort == 8883)
        #expect(manager.useTLS)
        #expect(manager.isPaired)
        #expect(cache.endpoint?.host == "broker.example.com")
        #expect(store.saved?.userOverride == false)
    }

    @Test("a user-chosen server survives a server broker address")
    func userOverrideBeatsServerBrokerConfig() throws {
        let store = InMemoryStore()
        let cache = InMemoryBrokerCache()
        let manager = makeManager(store: store, cache: cache)
        try manager.updateMQTTServer(host: "my.own.broker")

        manager.applyServerBrokerConfig(
            MQTTEndpoint(host: "broker.example.com", port: 8883, useTLS: true)
        )

        #expect(manager.brokerHost == "my.own.broker")
        // Still cached, so it takes over once the override is cleared.
        #expect(cache.endpoint?.host == "broker.example.com")
    }

    @Test("unpair clears state and store")
    func unpairClearsEverything() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)
        let url = URL(string: "teamclu://join?broker=mqtts://h&device=d&token=t")!
        try manager.pair(from: url)
        try manager.unpair()
        #expect(!manager.isPaired)
        #expect(manager.brokerHost == "")
        #expect(manager.authToken == "")
        #expect(store.saved == nil)
    }
}
