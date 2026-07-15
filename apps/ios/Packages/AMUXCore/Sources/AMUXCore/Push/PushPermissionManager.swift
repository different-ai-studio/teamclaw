import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

@MainActor
public enum PushPermissionManager {
    /// Returns true if the user granted alert/sound/badge.
    public static func requestIfUndetermined() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            #if canImport(UIKit)
            UIApplication.shared.registerForRemoteNotifications()
            #endif
            return true
        case .denied:
            return false
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(
                options: [.alert, .sound, .badge])) ?? false
            if granted {
                #if canImport(UIKit)
                UIApplication.shared.registerForRemoteNotifications()
                #endif
            }
            return granted
        @unknown default:
            return false
        }
    }
}
