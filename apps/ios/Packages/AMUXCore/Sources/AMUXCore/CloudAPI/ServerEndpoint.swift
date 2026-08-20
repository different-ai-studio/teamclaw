import Foundation

/// Pre-auth "choose your server" support. Self-host deployments point the
/// app at their own Cloud API from the login screen; everything else the
/// app needs (MQTT broker address, feature config) is discovered from that
/// base URL via `/v1/config/bootstrap`, so the Cloud API address is the
/// only thing a user ever has to type.
public enum ServerEndpoint {
    /// Turns user input into a canonical Cloud API base URL: trims
    /// whitespace, defaults the scheme to https, drops trailing slashes,
    /// and requires a host. Returns nil for input that cannot name a
    /// server — a bad value must never be persisted, or it wedges the app
    /// at launch.
    public static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") {
            text = "https://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        guard let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty
        else { return nil }
        return components.url
    }

    public enum ProbeOutcome: Equatable, Sendable {
        case reachable
        case badStatus(Int)
        case unreachable(String)
    }

    /// Asks the candidate server for its public config. A 200 from
    /// `GET /v1/config/public` is proof enough that a TeamClu Cloud API
    /// lives at this base URL; no auth is required.
    public static func probe(_ baseURL: URL, session: URLSession = .shared) async -> ProbeOutcome {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/config/public"))
        request.httpMethod = "GET"
        request.timeoutInterval = 6
        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .unreachable("no HTTP response")
            }
            return http.statusCode == 200 ? .reachable : .badStatus(http.statusCode)
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}

public extension CloudAPIConfigurationStore {
    /// The server the app talks to when no override is stored.
    static var bundledCloudAPIURL: String? {
        let value = SharedDefaults.services.cloudApiUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }

    static func hasCloudAPIURLOverride(in defaults: UserDefaults = .standard) -> Bool {
        let raw = defaults.string(forKey: cloudAPIURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw?.isEmpty == false
    }

    /// Persists (or clears, when nil) the user-chosen Cloud API base URL.
    /// Callers pass a URL from `ServerEndpoint.normalize` — raw user text
    /// is not accepted here.
    static func setCloudAPIURLOverride(_ url: URL?, in defaults: UserDefaults = .standard) {
        if let url {
            defaults.set(url.absoluteString, forKey: cloudAPIURLKey)
        } else {
            defaults.removeObject(forKey: cloudAPIURLKey)
        }
    }
}
