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

    @Test("pairs from a valid teamclaw:// URL with mqtts broker")
    func pairsFromValidURL() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)

        let url = URL(string: "teamclaw://join?broker=mqtts://broker.example.com:8883&device=mac-1&token=tok-abc")!
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
        let url = URL(string: "teamclaw://join?broker=mqtts://broker.example.com&device=d&token=t")!
        try manager.pair(from: url)
        #expect(manager.brokerPort == 8883)
        #expect(manager.useTLS == true)
    }

    @Test("defaults port 1883 for mqtt:// (non-TLS)")
    func defaultsPortForMqttPlain() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)
        let url = URL(string: "teamclaw://join?broker=mqtt://broker.example.com&device=d&token=t")!
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
        let url = URL(string: "teamclaw://join?device=d&token=t")!  // no broker
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

    @Test("ignores an auto-applied stored host and re-applies the bundled default")
    func ignoresStaleAutoDefaultOnInit() throws {
        let store = InMemoryStore()
        // Host persisted by an older build (no user override) must NOT win over
        // the current bundled default.
        store.saved = PairingCredentials(
            brokerHost: "stale.example.com", brokerPort: 1883, useTLS: false,
            authToken: "", userOverride: false
        )
        let manager = PairingManager(store: store)
        #expect(manager.brokerHost == SharedDefaults.services.mqttHost)
        #expect(manager.brokerHost != "stale.example.com")
    }

    @Test("unpair clears state and store")
    func unpairClearsEverything() throws {
        let store = InMemoryStore()
        let manager = PairingManager(store: store)
        let url = URL(string: "teamclaw://join?broker=mqtts://h&device=d&token=t")!
        try manager.pair(from: url)
        try manager.unpair()
        #expect(!manager.isPaired)
        #expect(manager.brokerHost == "")
        #expect(manager.authToken == "")
        #expect(store.saved == nil)
    }
}
