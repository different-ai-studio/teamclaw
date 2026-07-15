#if os(iOS)
import AuthenticationServices
import CryptoKit
import UIKit
import Foundation

@MainActor
public final class AppleSignInHandler: NSObject {
    public static let shared = AppleSignInHandler()

    private var continuation: CheckedContinuation<(idToken: String, nonce: String), Error>?
    private var rawNonce: String = ""

    public func request() async throws -> (idToken: String, nonce: String) {
        try await withCheckedThrowingContinuation { continuation in
            // If a previous request is still in flight, cancel it so its
            // continuation isn't leaked when we overwrite `self.continuation`.
            if let stale = self.continuation {
                stale.resume(throwing: CancellationError())
            }
            self.continuation = continuation
            let (raw, hashed) = Self.makeNonce()
            self.rawNonce = raw

            let provider = ASAuthorizationAppleIDProvider()
            let req = provider.createRequest()
            req.requestedScopes = [.fullName, .email]
            req.nonce = hashed

            let controller = ASAuthorizationController(authorizationRequests: [req])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private static func makeNonce() -> (raw: String, hashed: String) {
        let chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        let raw = (0..<32).map { _ in chars.randomElement()! }.map(String.init).joined()
        let digest = SHA256.hash(data: Data(raw.utf8))
        let hashed = digest.map { String(format: "%02x", $0) }.joined()
        return (raw, hashed)
    }
}

extension AppleSignInHandler: ASAuthorizationControllerDelegate {
    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let idToken = String(data: tokenData, encoding: .utf8)
        else {
            continuation?.resume(throwing: ASAuthorizationError(.failed))
            continuation = nil
            return
        }
        continuation?.resume(returning: (idToken: idToken, nonce: rawNonce))
        continuation = nil
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

extension AppleSignInHandler: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? UIWindow()
    }
}
#endif
