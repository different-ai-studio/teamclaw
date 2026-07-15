import XCTest
@testable import AMUXCore

final class AuthHTTPTests: XCTestCase {
    func testPostNoBearerSendsBodyWithoutAuthHeader() async throws {
        let captured = LockedBox<URLRequest>()
        let send: CloudAPISend = { req in
            captured.set(req)
            let data = #"{"ok":true}"#.data(using: .utf8)!
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (data, resp)
        }
        let http = AuthHTTP(baseURL: URL(string: "https://cloud.example")!, send: send)
        struct Body: Encodable { let email: String }
        struct Out: Decodable { let ok: Bool }
        let out: Out = try await http.post("/v1/auth/signin-otp", body: Body(email: "a@b.com"))
        XCTAssertTrue(out.ok)
        let req = captured.get()!
        XCTAssertEqual(req.url?.absoluteString, "https://cloud.example/v1/auth/signin-otp")
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
    }

    func testPostWithBearerSetsAuthHeader() async throws {
        let captured = LockedBox<URLRequest>()
        let send: CloudAPISend = { req in
            captured.set(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (#"{"ok":true}"#.data(using: .utf8)!, resp)
        }
        let http = AuthHTTP(baseURL: URL(string: "https://cloud.example")!, send: send)
        struct Out: Decodable { let ok: Bool }
        let _: Out = try await http.post("/v1/auth/signout", body: EmptyBody(), bearer: "TOKEN")
        XCTAssertEqual(captured.get()?.value(forHTTPHeaderField: "Authorization"), "Bearer TOKEN")
    }

    func testNon2xxThrowsRequestFailed() async {
        let send: CloudAPISend = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
            return (#"{"error":{"code":"missing_auth","message":"no"}}"#.data(using: .utf8)!, resp)
        }
        let http = AuthHTTP(baseURL: URL(string: "https://cloud.example")!, send: send)
        struct Out: Decodable { let ok: Bool }
        do { let _: Out = try await http.post("/v1/auth/refresh", body: EmptyBody()); XCTFail("expected throw") }
        catch let CloudAPIError.requestFailed(status, code, _) {
            XCTAssertEqual(status, 401); XCTAssertEqual(code, "missing_auth")
        } catch { XCTFail("wrong error: \(error)") }
    }

    func testDetailsErrorCodePreferredOverCollapsedCode() async {
        // FC collapses GoTrue 422s to code:"validation_failed" and tucks the
        // real machine code under details.error_code. AuthHTTP should surface
        // the specific one so callers can classify the failure.
        let body = #"{"error":{"code":"validation_failed","message":"auth.updateUser: Email address already registered","details":{"error_code":"email_exists","msg":"Email address already registered","code":422}}}"#
        let send: CloudAPISend = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 422, httpVersion: nil, headerFields: nil)!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthHTTP(baseURL: URL(string: "https://cloud.example")!, send: send)
        struct Out: Decodable { let ok: Bool }
        do { let _: Out = try await http.patch("/v1/auth/user", body: EmptyBody(), bearer: "T"); XCTFail("expected throw") }
        catch let CloudAPIError.requestFailed(status, code, _) {
            XCTAssertEqual(status, 422); XCTAssertEqual(code, "email_exists")
        } catch { XCTFail("wrong error: \(error)") }
    }

    func testMissingDetailsFallsBackToCollapsedCode() async {
        let body = #"{"error":{"code":"validation_failed","message":"Password is too weak"}}"#
        let send: CloudAPISend = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 422, httpVersion: nil, headerFields: nil)!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthHTTP(baseURL: URL(string: "https://cloud.example")!, send: send)
        struct Out: Decodable { let ok: Bool }
        do { let _: Out = try await http.patch("/v1/auth/user", body: EmptyBody(), bearer: "T"); XCTFail("expected throw") }
        catch let CloudAPIError.requestFailed(status, code, _) {
            XCTAssertEqual(status, 422); XCTAssertEqual(code, "validation_failed")
        } catch { XCTFail("wrong error: \(error)") }
    }
}

// Test helper: a minimal thread-safe box (avoids data races in @Sendable closures).
final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock(); private var value: T?
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func get() -> T? { lock.lock(); defer { lock.unlock() }; return value }
}
