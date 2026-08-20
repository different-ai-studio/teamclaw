import Foundation

/// Login-screen feature flags from `GET /v1/config/public` (`features.auth`).
/// The login screen renders before any token exists, so these ride the one
/// unauthenticated config endpoint — mirroring the desktop's remote-features
/// gating (packages/app/src/lib/remote-features.ts).
///
/// Email OTP and Sign in with Apple are never gated on iOS: email OTP is the
/// base method, and Apple sign-in is an App Store requirement whenever other
/// third-party logins exist.
public struct PublicAuthFlags: Equatable, Sendable {
    public var google: Bool
    public var phone: Bool
    public var password: Bool

    public init(google: Bool, phone: Bool, password: Bool) {
        self.google = google
        self.phone = phone
        self.password = password
    }

    /// Used when the server can't be reached at all: every method stays
    /// available rather than stripping sign-in options on a network hiccup.
    /// A server answer — including one with no auth block, which means
    /// "everything optional is off" — always wins over this.
    public static let failOpen = PublicAuthFlags(google: true, phone: true, password: true)

    public static let allOff = PublicAuthFlags(google: false, phone: false, password: false)

    /// nil only on transport failure; an answering server always yields
    /// flags (missing keys read as off, matching the desktop's defaults).
    public static func fetch(baseURL: URL, session: URLSession = .shared) async -> PublicAuthFlags? {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/config/public"))
        request.httpMethod = "GET"
        request.timeoutInterval = 8
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200
        else { return nil }

        struct PublicConfig: Decodable {
            struct Features: Decodable {
                struct Auth: Decodable {
                    let google: Bool?
                    let phone: Bool?
                    let password: Bool?
                }
                let auth: Auth?
            }
            let features: Features?
        }

        guard let config = try? JSONDecoder().decode(PublicConfig.self, from: data) else {
            return nil
        }
        let auth = config.features?.auth
        return PublicAuthFlags(
            google: auth?.google ?? false,
            phone: auth?.phone ?? false,
            password: auth?.password ?? false
        )
    }
}
