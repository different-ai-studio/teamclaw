import XCTest
@testable import AMUXCore

// Pure test fixtures, kept as file-private free functions so the
// `@Sendable CloudAPISend` closures below can call them without capturing the
// (non-Sendable) XCTestCase `self` — which Swift 6 strict concurrency rejects.
private func config() -> CloudAPIConfiguration {
    CloudAPIConfiguration(
        baseURL: URL(string: "https://cloud.example")!
    )
}

/// A GoTrue session body with an access token, refresh token, and user.
private func goTrueJSON(
    accessToken: String = "at-1",
    refreshToken: String = "rt-1",
    expiresAt: Int = 9_000_000_000,
    isAnonymous: Bool = false,
    email: String? = "user@example.com",
    identities: [String]? = ["apple"]
) -> String {
    let emailJSON = email.map { "\"\($0)\"" } ?? "null"
    let identitiesJSON: String
    if let identities {
        let entries = identities.map { "{\"id\":\"\($0)\"}" }.joined(separator: ",")
        identitiesJSON = "[\(entries)]"
    } else {
        identitiesJSON = "null"
    }
    return """
    {
      "access_token": "\(accessToken)",
      "refresh_token": "\(refreshToken)",
      "expires_at": \(expiresAt),
      "expires_in": 3600,
      "user": {
        "id": "user-id",
        "email": \(emailJSON),
        "is_anonymous": \(isAnonymous),
        "identities": \(identitiesJSON)
      }
    }
    """
}

private func response(_ url: URL, status: Int = 200) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
}

final class CloudAPIAppOnboardingStoreTests: XCTestCase {
    func testSignInStoresSessionFromGoTrueBody() async throws {
        let captured = LockedBox<URLRequest>()
        let send: CloudAPISend = { req in
            captured.set(req)
            return (goTrueJSON(accessToken: "AT", email: "alice@example.com", identities: ["email"]).data(using: .utf8)!,
                    response(req.url!))
        }
        let storage = InMemorySessionStorage()
        let store = CloudAPIAppOnboardingStore(configuration: config(), storage: storage, send: send)

        try await store.signIn(email: "alice@example.com", password: "secret")

        let req = captured.get()!
        XCTAssertEqual(req.url?.absoluteString, "https://cloud.example/v1/auth/signin-password")
        // The store awaits the actor, so the session is committed by now.
        let stored = try storage.load()
        XCTAssertEqual(stored?.accessToken, "AT")
        XCTAssertEqual(stored?.email, "alice@example.com")
        XCTAssertEqual(stored?.isAnonymous, false)
        let token = try await store.accessToken()
        XCTAssertEqual(token, "AT")
        let anon = await store.isAnonymous()
        XCTAssertFalse(anon)
        let email = await store.currentUserEmail()
        XCTAssertEqual(email, "alice@example.com")
    }

    func testSignUpEmailAlreadyInUseThrows() async {
        // 200 GoTrue body with no access_token and empty identities → anti-enumeration.
        let body = """
        {
          "user": {
            "id": "user-id",
            "email": "taken@example.com",
            "is_anonymous": false,
            "identities": []
          }
        }
        """
        let send: CloudAPISend = { req in
            (body.data(using: .utf8)!, response(req.url!))
        }
        let store = CloudAPIAppOnboardingStore(configuration: config(), storage: InMemorySessionStorage(), send: send)
        do {
            try await store.signUp(email: "taken@example.com", password: "secret")
            XCTFail("expected emailAlreadyInUse")
        } catch SignUpOutcome.emailAlreadyInUse {
            // expected
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func testSignUpEmailConfirmationRequiredThrows() async {
        // 200 GoTrue body with no access_token but a non-empty identities list.
        let body = """
        {
          "user": {
            "id": "user-id",
            "email": "new@example.com",
            "is_anonymous": false,
            "identities": [{"id":"email"}]
          }
        }
        """
        let send: CloudAPISend = { req in
            (body.data(using: .utf8)!, response(req.url!))
        }
        let store = CloudAPIAppOnboardingStore(configuration: config(), storage: InMemorySessionStorage(), send: send)
        do {
            try await store.signUp(email: "new@example.com", password: "secret")
            XCTFail("expected emailConfirmationRequired")
        } catch SignUpOutcome.emailConfirmationRequired {
            // expected
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func testSignInAnonymouslyStoresAnonymousSession() async throws {
        let captured = LockedBox<URLRequest>()
        let send: CloudAPISend = { req in
            captured.set(req)
            return (goTrueJSON(accessToken: "ANON", isAnonymous: true, email: nil, identities: []).data(using: .utf8)!,
                    response(req.url!))
        }
        let store = CloudAPIAppOnboardingStore(configuration: config(), storage: InMemorySessionStorage(), send: send)

        try await store.signInAnonymously()

        XCTAssertEqual(captured.get()?.url?.absoluteString, "https://cloud.example/v1/auth/signin-anonymous")
        let anon = await store.isAnonymous()
        XCTAssertTrue(anon)
        let email = await store.currentUserEmail()
        XCTAssertNil(email)
        let token = try await store.accessToken()
        XCTAssertEqual(token, "ANON")
    }
}
