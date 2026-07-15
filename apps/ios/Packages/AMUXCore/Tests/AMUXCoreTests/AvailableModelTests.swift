import Testing
import Foundation
@testable import AMUXCore

@Suite("AvailableModel JSON round-trip")
struct AvailableModelTests {
    @Test func encodeAndDecodeRoundTrip() throws {
        let models = [
            AvailableModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
            AvailableModel(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
        ]
        let json = try JSONEncoder().encode(models)
        let decoded = try JSONDecoder().decode([AvailableModel].self, from: json)
        #expect(decoded == models)
    }

    @Test func emptyArrayRoundTrip() throws {
        let models: [AvailableModel] = []
        let json = try JSONEncoder().encode(models)
        let decoded = try JSONDecoder().decode([AvailableModel].self, from: json)
        #expect(decoded.isEmpty)
        #expect(String(data: json, encoding: .utf8) == "[]")
    }
}
