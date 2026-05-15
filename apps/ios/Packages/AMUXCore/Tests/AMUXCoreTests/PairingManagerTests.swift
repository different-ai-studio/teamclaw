import Testing
import Foundation
@testable import AMUXCore

@Suite("PairingManager")
struct PairingManagerTests {

    final class InMemoryStore: CredentialStore {
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

    @Test("loads previously stored credentials on init")
    func loadsStoredCredentialsOnInit() throws {
        let store = InMemoryStore()
        store.saved = PairingCredentials(
            brokerHost: "h", brokerPort: 8883, useTLS: true,
            authToken: "t"
        )
        let manager = PairingManager(store: store)
        #expect(manager.isPaired)
        #expect(manager.brokerHost == "h")
        #expect(manager.authToken == "t")
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
