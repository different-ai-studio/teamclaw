import Testing
import Foundation
@testable import AMUXCore

@Suite("ServerBrokerConfig")
struct ServerBrokerConfigTests {

    @Test("parses a scheme-qualified TLS broker URL")
    func parsesMqttsURL() {
        let endpoint = MQTTEndpoint.parse("mqtts://broker.example.com:8883")
        #expect(endpoint == MQTTEndpoint(host: "broker.example.com", port: 8883, useTLS: true))
    }

    @Test("parses a plaintext broker URL")
    func parsesMqttURL() {
        let endpoint = MQTTEndpoint.parse("mqtt://broker.example.com:1883")
        #expect(endpoint == MQTTEndpoint(host: "broker.example.com", port: 1883, useTLS: false))
    }

    @Test("drops the path from a WebSocket URL")
    func parsesWebSocketURL() {
        let endpoint = MQTTEndpoint.parse("wss://mqtt.example.com/mqtt")
        // No explicit port: the scheme implies the standard TLS MQTT port.
        #expect(endpoint == MQTTEndpoint(host: "mqtt.example.com", port: 8883, useTLS: true))
    }

    @Test("a bare host:port keeps the caller's TLS default")
    func parsesBareHostPort() {
        let endpoint = MQTTEndpoint.parse("broker.example.com:1884", defaultUseTLS: true)
        #expect(endpoint == MQTTEndpoint(host: "broker.example.com", port: 1884, useTLS: true))
    }

    @Test("rejects empty and unknown-scheme addresses")
    func rejectsGarbage() {
        #expect(MQTTEndpoint.parse("") == nil)
        #expect(MQTTEndpoint.parse("   ") == nil)
        #expect(MQTTEndpoint.parse("ftp://broker.example.com") == nil)
        #expect(MQTTEndpoint.parse("mqtts://") == nil)
    }

    @Test("prefers tcpUrl over the WebSocket url")
    func fetchPrefersTcpURL() async throws {
        let client = makeClient(body: """
        {"mqtt":{"url":"wss://mqtt.example.com/mqtt","tcpUrl":"mqtts://mqtt.example.com:8883"}}
        """)
        let endpoint = try await ServerBrokerConfig.fetch(client: client)
        #expect(endpoint == MQTTEndpoint(host: "mqtt.example.com", port: 8883, useTLS: true))
    }

    @Test("falls back to url when no tcpUrl is offered")
    func fetchFallsBackToURL() async throws {
        let client = makeClient(body: """
        {"mqtt":{"url":"mqtt://mqtt.example.com:1883"}}
        """)
        let endpoint = try await ServerBrokerConfig.fetch(client: client)
        #expect(endpoint == MQTTEndpoint(host: "mqtt.example.com", port: 1883, useTLS: false))
    }

    @Test("returns nil when the deployment configures no broker")
    func fetchWithoutMqttBlock() async throws {
        let client = makeClient(body: #"{"webSso":{"loginUrl":"https://example.com"}}"#)
        #expect(try await ServerBrokerConfig.fetch(client: client) == nil)
    }

    private func makeClient(body: String) -> CloudAPIClient {
        CloudAPIClient(
            configuration: CloudAPIConfiguration(baseURL: URL(string: "https://api.example.com")!),
            accessToken: { "test-token" },
            send: { request in
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
                )!
                return (Data(body.utf8), response)
            }
        )
    }
}
