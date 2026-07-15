import Foundation
import Security

public struct StoredSession: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var isAnonymous: Bool
    public var email: String?

    public init(accessToken: String, refreshToken: String, expiresAt: Date, isAnonymous: Bool, email: String?) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.isAnonymous = isAnonymous
        self.email = email
    }
}

public protocol SessionStorage: Sendable {
    func load() throws -> StoredSession?
    func save(_ session: StoredSession) throws
    func clear() throws
}

/// In-memory storage for tests (Keychain is unavailable in SwiftPM test hosts).
public final class InMemorySessionStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    public init() {}
    public func load() throws -> StoredSession? {
        lock.lock(); defer { lock.unlock() }
        guard let data else { return nil }
        return try JSONDecoder().decode(StoredSession.self, from: data)
    }
    public func save(_ session: StoredSession) throws {
        lock.lock(); defer { lock.unlock() }
        data = try JSONEncoder().encode(session)
    }
    public func clear() throws { lock.lock(); defer { lock.unlock() }; data = nil }
}

/// Keychain-backed storage. One JSON blob under our own service/account,
/// independent of the Supabase SDK's Keychain entry.
public struct KeychainSessionStorage: SessionStorage {
    private let service: String
    private let account: String

    public init(service: String = "tech.teamclaw.mobile.auth", account: String = "cloud_api_session") {
        self.service = service
        self.account = account
    }

    public func load() throws -> StoredSession? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainError.unexpectedStatus(status)
        }
        return try JSONDecoder().decode(StoredSession.self, from: data)
    }

    public func save(_ session: StoredSession) throws {
        let data = try JSONEncoder().encode(session)
        let query = baseQuery()
        let attrs: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var insert = baseQuery()
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.unexpectedStatus(addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

public enum KeychainError: Error, Equatable {
    case unexpectedStatus(OSStatus)
}
