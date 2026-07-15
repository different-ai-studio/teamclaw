import Foundation

public protocol PushTokenUploader: Sendable {
    func upload(userID: String, deviceID: String, platform: String,
                provider: String, token: String, appVersion: String?) async throws
}

public actor PushService {
    private let uploader: PushTokenUploader
    private let userIDProvider: @Sendable () -> String?
    private let deviceIDProvider: @Sendable () -> String?
    private let appVersionProvider: @Sendable () -> String?

    public init(uploader: PushTokenUploader,
                userIDProvider: @escaping @Sendable () -> String?,
                deviceIDProvider: @escaping @Sendable () -> String?,
                appVersionProvider: @escaping @Sendable () -> String?) {
        self.uploader = uploader
        self.userIDProvider = userIDProvider
        self.deviceIDProvider = deviceIDProvider
        self.appVersionProvider = appVersionProvider
    }

    public func uploadToken(_ hex: String) async throws {
        guard let uid = userIDProvider(), let did = deviceIDProvider() else { return }
        try await uploader.upload(
            userID: uid, deviceID: did,
            platform: "ios", provider: "apns",
            token: hex, appVersion: appVersionProvider()
        )
    }
}
