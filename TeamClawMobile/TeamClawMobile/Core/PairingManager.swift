import Foundation

// MARK: - PairingCredentials

struct PairingCredentials {
    let mqttHost: String
    let mqttPort: UInt16
    let mqttUsername: String
    let mqttPassword: String
    let teamID: String
    let deviceID: String
    let desktopDeviceName: String
}

// MARK: - PairingManager

final class PairingManager: ObservableObject {

    // MARK: - Published Properties

    @Published var isPaired = false
    @Published var pairedDeviceName: String?
    @Published var pairingError: String?

    // MARK: - UserDefaults Keys

    private enum Keys {
        static let isPaired = "teamclaw_is_paired"
        static let pairedDeviceName = "teamclaw_paired_device_name"
        static let mqttHost = "teamclaw_mqtt_host"
        static let mqttPort = "teamclaw_mqtt_port"
        static let mqttUsername = "teamclaw_mqtt_username"
        static let mqttPassword = "teamclaw_mqtt_password"
        static let teamID = "teamclaw_team_id"
        static let deviceID = "teamclaw_device_id"
    }

    // MARK: - Init

    init() {
        isPaired = UserDefaults.standard.bool(forKey: Keys.isPaired)
        pairedDeviceName = UserDefaults.standard.string(forKey: Keys.pairedDeviceName)
    }

    // MARK: - Computed Properties

    var credentials: PairingCredentials? {
        guard isPaired,
              let host = UserDefaults.standard.string(forKey: Keys.mqttHost),
              let username = UserDefaults.standard.string(forKey: Keys.mqttUsername),
              let password = UserDefaults.standard.string(forKey: Keys.mqttPassword),
              let teamID = UserDefaults.standard.string(forKey: Keys.teamID),
              let deviceID = UserDefaults.standard.string(forKey: Keys.deviceID),
              let deviceName = UserDefaults.standard.string(forKey: Keys.pairedDeviceName)
        else { return nil }

        let port = UInt16(UserDefaults.standard.integer(forKey: Keys.mqttPort))

        return PairingCredentials(
            mqttHost: host,
            mqttPort: port == 0 ? 1883 : port,
            mqttUsername: username,
            mqttPassword: password,
            teamID: teamID,
            deviceID: deviceID,
            desktopDeviceName: deviceName
        )
    }

    // MARK: - Methods

    func pair(with code: String) {
        guard code.count == 6, code.allSatisfy(\.isNumber) else {
            pairingError = "配对码必须是 6 位数字"
            return
        }

        pairingError = nil

        // Simulate pairing with mock credentials
        let mockDeviceName = "我的 Mac"
        UserDefaults.standard.set(true, forKey: Keys.isPaired)
        UserDefaults.standard.set(mockDeviceName, forKey: Keys.pairedDeviceName)
        UserDefaults.standard.set("mqtt.teamclaw.local", forKey: Keys.mqttHost)
        UserDefaults.standard.set(1883, forKey: Keys.mqttPort)
        UserDefaults.standard.set("teamclaw_user", forKey: Keys.mqttUsername)
        UserDefaults.standard.set("mock_password_\(code)", forKey: Keys.mqttPassword)
        UserDefaults.standard.set("team_\(code.prefix(3))", forKey: Keys.teamID)
        UserDefaults.standard.set("device_\(code.suffix(3))", forKey: Keys.deviceID)

        isPaired = true
        pairedDeviceName = mockDeviceName
    }

    func unpair() {
        UserDefaults.standard.removeObject(forKey: Keys.isPaired)
        UserDefaults.standard.removeObject(forKey: Keys.pairedDeviceName)
        UserDefaults.standard.removeObject(forKey: Keys.mqttHost)
        UserDefaults.standard.removeObject(forKey: Keys.mqttPort)
        UserDefaults.standard.removeObject(forKey: Keys.mqttUsername)
        UserDefaults.standard.removeObject(forKey: Keys.mqttPassword)
        UserDefaults.standard.removeObject(forKey: Keys.teamID)
        UserDefaults.standard.removeObject(forKey: Keys.deviceID)

        isPaired = false
        pairedDeviceName = nil
        pairingError = nil
    }
}
