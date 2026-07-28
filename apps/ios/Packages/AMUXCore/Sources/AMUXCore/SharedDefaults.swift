import Foundation

/// Values baked into the app bundle. Deliberately holds NO broker host: the
/// broker address comes from the Cloud API (`GET /v1/config/bootstrap`, see
/// `ServerBrokerConfig`) and is cached on device, so moving the broker does not
/// need an App Store release. Only the transport fallbacks stay here, for
/// parsing an address that omits a port or scheme.
public struct ServicesDefaults: Codable, Sendable {
    public let cloudApiUrl: String?
    public let mqttPort: Int
    public let mqttUseTls: Bool
}

public enum SharedDefaults {
    public static let services: ServicesDefaults = {
        guard let url = Bundle.module.url(forResource: "services.default", withExtension: "json") else {
            fatalError("services.default.json missing from AMUXCore bundle resources")
        }
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(ServicesDefaults.self, from: data)
        } catch {
            fatalError("services.default.json is malformed: \(error)")
        }
    }()
}
