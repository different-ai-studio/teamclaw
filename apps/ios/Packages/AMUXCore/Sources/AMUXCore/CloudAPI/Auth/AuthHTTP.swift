import Foundation

/// Lightweight HTTP for the `auth:"none"` FC endpoints. Unlike `CloudAPIClient`,
/// it does not require a bearer token (auth endpoints are unauthenticated, or
/// take an explicit bearer for signout / identity-link).
public struct EmptyBody: Encodable, Sendable {
    public init() {}
}

public struct AuthHTTP: Sendable {
    private let baseURL: URL
    private let send: CloudAPISend

    public init(baseURL: URL, send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend) {
        self.baseURL = baseURL
        self.send = send
    }

    public func post<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String, body: Body, bearer: String? = nil, as type: T.Type = T.self
    ) async throws -> T {
        let data = try await perform("POST", path: path, body: try JSONEncoder().encode(body), bearer: bearer)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func postVoid<Body: Encodable & Sendable>(
        _ path: String, body: Body, bearer: String? = nil
    ) async throws {
        _ = try await perform("POST", path: path, body: try JSONEncoder().encode(body), bearer: bearer)
    }

    public func patch<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String, body: Body, bearer: String?, as type: T.Type = T.self
    ) async throws -> T {
        let data = try await perform("PATCH", path: path, body: try JSONEncoder().encode(body), bearer: bearer)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func perform(_ method: String, path: String, body: Data?, bearer: String?) async throws -> Data {
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: "\(base)\(p)") else { throw CloudAPIError.invalidResponse }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await send(req)
        guard (200..<300).contains(response.statusCode) else {
            let env = try? JSONDecoder().decode(AuthErrorEnvelope.self, from: data)
            // FC collapses every GoTrue 422 to `code: "validation_failed"` and
            // tucks the real machine code under `details.error_code`
            // (e.g. "email_exists" / "phone_exists"). Prefer that specific code
            // so callers can classify the failure precisely instead of parsing
            // the human-facing message.
            let code = env?.error.details?.errorCode ?? env?.error.code
            throw CloudAPIError.requestFailed(
                status: response.statusCode,
                code: code,
                message: env?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            )
        }
        return data
    }
}

private struct AuthErrorEnvelope: Decodable { let error: AuthErrorBody }
private struct AuthErrorBody: Decodable {
    let code: String?
    let message: String?
    let details: AuthErrorDetails?
}
private struct AuthErrorDetails: Decodable {
    let errorCode: String?
    enum CodingKeys: String, CodingKey { case errorCode = "error_code" }
}
