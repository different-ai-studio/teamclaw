import Foundation

public enum BackendProviderKind: String, Sendable {
    case supabase
    case cloudAPI = "cloud_api"
}

public struct CloudAPIConfiguration: Equatable, Sendable {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }
}

public enum CloudAPIConfigurationStore {
    public static let backendKindKey = "teamclaw_backend_kind"
    public static let cloudAPIURLKey = "teamclaw_cloud_api_url"

    public static func backendKind(in defaults: UserDefaults = .standard) -> BackendProviderKind {
        // An explicit stored value always wins (Settings override / tests).
        if let raw = defaults.string(forKey: backendKindKey),
           let kind = BackendProviderKind(rawValue: raw) {
            return kind
        }
        // No stored preference: default to the Cloud API whenever a cloud
        // endpoint is resolvable (bundled `cloudApiUrl` or a UserDefaults
        // override). This makes the Cloud API the production default — direct
        // Supabase is only used as a fallback when no cloud URL is configured.
        let rawCloudURL = defaults.string(forKey: cloudAPIURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let bundledCloudURL = SharedDefaults.services.cloudApiUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasCloudURL = (rawCloudURL?.isEmpty == false) || (bundledCloudURL?.isEmpty == false)
        return hasCloudURL ? .cloudAPI : .supabase
    }

    public static func storedCloudAPIURL(in defaults: UserDefaults = .standard) -> String? {
        let value = defaults.string(forKey: cloudAPIURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : SharedDefaults.services.cloudApiUrl
    }

    public static func configuration(in defaults: UserDefaults = .standard) -> CloudAPIConfiguration? {
        guard backendKind(in: defaults) == .cloudAPI,
              let rawCloudURL = storedCloudAPIURL(in: defaults),
              let cloudURL = URL(string: rawCloudURL) else {
            return nil
        }

        return CloudAPIConfiguration(baseURL: cloudURL)
    }
}
