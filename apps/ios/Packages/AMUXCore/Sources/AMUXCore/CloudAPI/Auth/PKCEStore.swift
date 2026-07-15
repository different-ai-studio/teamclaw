import Foundation
import CryptoKit

/// Holds the PKCE code-verifier between the `authorize` redirect and the
/// `exchange` callback. The Cloud API drives the Google OAuth flow with PKCE:
/// the client generates a verifier + challenge, sends the challenge to the
/// authorize endpoint, then redeems the returned `code` together with the
/// stashed verifier at `/v1/auth/oauth/exchange`.
public actor PKCEStore {
    private var verifier: String?

    public init() {}

    /// Generate a fresh PKCE verifier, stash it, and return the corresponding
    /// S256 code challenge to send to the authorize endpoint.
    public func makeChallenge() -> String {
        let verifier = Self.randomURLSafe(byteCount: 32)
        self.verifier = verifier
        return Self.s256Challenge(for: verifier)
    }

    /// Consume the stashed verifier (one-shot). Returns nil if `makeChallenge`
    /// was never called or it was already taken.
    public func takeVerifier() -> String? {
        defer { verifier = nil }
        return verifier
    }

    // MARK: - Crypto helpers

    private static func randomURLSafe(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        if status != errSecSuccess {
            // Fallback to arc4random if SecRandom is unavailable (shouldn't
            // happen on-device); still cryptographically adequate for PKCE.
            for i in 0..<byteCount { bytes[i] = UInt8.random(in: .min ... .max) }
        }
        return base64URLEncode(Data(bytes))
    }

    private static func s256Challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncode(Data(digest))
    }

    private static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
