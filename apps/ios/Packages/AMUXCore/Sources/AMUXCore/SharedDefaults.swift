import Foundation

public struct ServicesDefaults: Codable, Sendable {
    public let cloudApiUrl: String?
    public let mqttHost: String
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
