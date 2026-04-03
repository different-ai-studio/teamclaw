import Foundation
import Combine
import CocoaMQTT
import UIKit

// MARK: - PairingCredentials

struct PairingCredentials {
    let mqttHost: String
    let mqttPort: UInt16
    let mqttUsername: String
    let mqttPassword: String
    let teamID: String
    let deviceID: String          // mobile's own device ID
    let desktopDeviceID: String   // desktop's device ID (for topic subscription)
    let desktopDeviceName: String
}

// MARK: - PairingManager

final class PairingManager: ObservableObject {

    // MARK: - Published Properties

    @Published var isPaired = false
    @Published var pairedDeviceName: String?
    @Published var pairingError: String?
    @Published var isPairing = false

    // MARK: - UserDefaults Keys

    private enum Keys {
        static let isPaired          = "teamclaw_is_paired"
        static let pairedDeviceName  = "teamclaw_paired_device_name"
        static let mqttHost          = "teamclaw_mqtt_host"
        static let mqttPort          = "teamclaw_mqtt_port"
        static let mqttUsername      = "teamclaw_mqtt_username"
        static let mqttPassword      = "teamclaw_mqtt_password"
        static let teamID            = "teamclaw_team_id"
        static let deviceID          = "teamclaw_device_id"
        static let desktopDeviceID   = "teamclaw_desktop_device_id"
    }

    // Shared broker credentials used during pairing handshake
    static let sharedHost     = "a81fb6d3.ala.cn-hangzhou.emqxsl.cn"
    static let sharedPort: UInt16 = 8883
    static let sharedUsername = "teamclaw_ios"
    static let sharedPassword = "teamclaw_ios"

    // MARK: - Init

    init() {
        isPaired = UserDefaults.standard.bool(forKey: Keys.isPaired)
        pairedDeviceName = UserDefaults.standard.string(forKey: Keys.pairedDeviceName)
    }

    // MARK: - Computed Properties

    var credentials: PairingCredentials? {
        guard isPaired,
              let host        = UserDefaults.standard.string(forKey: Keys.mqttHost),
              let username    = UserDefaults.standard.string(forKey: Keys.mqttUsername),
              let password    = UserDefaults.standard.string(forKey: Keys.mqttPassword),
              let teamID      = UserDefaults.standard.string(forKey: Keys.teamID),
              let deviceID    = UserDefaults.standard.string(forKey: Keys.deviceID),
              let desktopID   = UserDefaults.standard.string(forKey: Keys.desktopDeviceID),
              let deviceName  = UserDefaults.standard.string(forKey: Keys.pairedDeviceName)
        else { return nil }

        let port = UInt16(UserDefaults.standard.integer(forKey: Keys.mqttPort))
        return PairingCredentials(
            mqttHost: host,
            mqttPort: port == 0 ? 8883 : port,
            mqttUsername: username,
            mqttPassword: password,
            teamID: teamID,
            deviceID: deviceID,
            desktopDeviceID: desktopID,
            desktopDeviceName: deviceName
        )
    }

    // MARK: - Pair

    /// Real pairing: connect with shared creds, discover desktop via retained status,
    /// then publish pair request and wait for credentials response.
    func pair(with code: String) {
        guard code.count == 6, code.allSatisfy(\.isNumber) else {
            pairingError = "配对码必须是 6 位数字"
            return
        }

        pairingError = nil
        isPairing = true

        let mobileDeviceID = UUID().uuidString.lowercased()

        Task {
            do {
                let result = try await PairingService.perform(
                    code: code,
                    mobileDeviceID: mobileDeviceID,
                    mobileDeviceName: UIDevice.current.name
                )

                await MainActor.run {
                    // Persist credentials
                    let ud = UserDefaults.standard
                    ud.set(true,                  forKey: Keys.isPaired)
                    ud.set(result.desktopName,    forKey: Keys.pairedDeviceName)
                    ud.set(result.host,           forKey: Keys.mqttHost)
                    ud.set(Int(result.port),      forKey: Keys.mqttPort)
                    ud.set(result.username,       forKey: Keys.mqttUsername)
                    ud.set(result.password,       forKey: Keys.mqttPassword)
                    ud.set(result.teamID,         forKey: Keys.teamID)
                    ud.set(mobileDeviceID,        forKey: Keys.deviceID)
                    ud.set(result.desktopDeviceID,forKey: Keys.desktopDeviceID)

                    isPaired = true
                    pairedDeviceName = result.desktopName
                    isPairing = false
                }
            } catch {
                await MainActor.run {
                    pairingError = error.localizedDescription
                    isPairing = false
                }
            }
        }
    }

    func unpair() {
        let ud = UserDefaults.standard
        [Keys.isPaired, Keys.pairedDeviceName, Keys.mqttHost, Keys.mqttPort,
         Keys.mqttUsername, Keys.mqttPassword, Keys.teamID, Keys.deviceID,
         Keys.desktopDeviceID].forEach { ud.removeObject(forKey: $0) }

        isPaired = false
        pairedDeviceName = nil
        pairingError = nil
    }
}

// MARK: - PairingResult

struct PairingResult {
    let host: String
    let port: UInt16
    let username: String
    let password: String
    let teamID: String
    let desktopDeviceID: String
    let desktopName: String
}

// MARK: - PairingService

/// Handles the MQTT pairing handshake.
/// Protocol:
///  1. Connect with shared credentials
///  2. Subscribe to `teamclaw/+/+/status` to discover desktop team_id & device_id
///  3. Subscribe to `teamclaw/{team_id}/pairing/{code}` for credentials response
///  4. Publish pair request to `teamclaw/{team_id}/pairing/{code}`
///  5. Receive credentials, disconnect, return result
actor PairingService {

    private var mqtt: CocoaMQTT5?
    private var continuation: CheckedContinuation<PairingResult, Error>?
    private let code: String
    private let mobileDeviceID: String
    private let mobileDeviceName: String

    private var discoveredTeamID: String?
    private var discoveredDesktopDeviceID: String?

    private var mqttDelegate: PairingMQTTDelegate?

    static func perform(
        code: String,
        mobileDeviceID: String,
        mobileDeviceName: String
    ) async throws -> PairingResult {
        let service = PairingService(
            code: code,
            mobileDeviceID: mobileDeviceID,
            mobileDeviceName: mobileDeviceName
        )
        return try await service.run()
    }

    private init(code: String, mobileDeviceID: String, mobileDeviceName: String) {
        self.code = code
        self.mobileDeviceID = mobileDeviceID
        self.mobileDeviceName = mobileDeviceName
    }

    private func run() async throws -> PairingResult {
        try await withCheckedThrowingContinuation { [weak self] cont in
            guard let self else { cont.resume(throwing: PairingError.cancelled); return }
            Task { await self.start(continuation: cont) }
        }
    }

    private func start(continuation: CheckedContinuation<PairingResult, Error>) {
        self.continuation = continuation

        let clientID = "teamclaw-ios-pair-\(UUID().uuidString.prefix(8))"
        NSLog("[Pairing] Connecting to \(PairingManager.sharedHost):\(PairingManager.sharedPort) as \(clientID)")
        NSLog("[Pairing] Username: \(PairingManager.sharedUsername)")

        let client = CocoaMQTT5(
            clientID: clientID,
            host: PairingManager.sharedHost,
            port: PairingManager.sharedPort
        )
        client.username = PairingManager.sharedUsername
        client.password = PairingManager.sharedPassword
        client.enableSSL = true
        client.allowUntrustCACertificate = true
        client.cleanSession = true
        client.keepAlive = 30
        client.sslSettings = [
            kCFStreamSSLPeerName as String: PairingManager.sharedHost as NSString
        ]
        client.didReceiveTrust = { _, _, completionHandler in
            completionHandler(true)
        }

        let delegate = PairingMQTTDelegate(service: self)
        self.mqttDelegate = delegate
        client.delegate = delegate

        mqtt = client
        let connected = client.connect()
        NSLog("[Pairing] connect() returned: \(connected)")
        if !connected {
            continuation.resume(throwing: PairingError.connectionFailed("connect() returned false"))
            self.continuation = nil
            self.mqttDelegate = nil
            return
        }

        // Timeout after 20 seconds
        Task {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            await self.fail(PairingError.timeout)
        }
    }

    private func fail(_ error: Error) {
        guard let cont = continuation else { return }
        continuation = nil
        mqtt?.disconnect()
        mqtt = nil
        mqttDelegate = nil
        cont.resume(throwing: error)
    }

    private func succeed(_ result: PairingResult) {
        guard let cont = continuation else { return }
        continuation = nil
        mqtt?.disconnect()
        mqtt = nil
        mqttDelegate = nil
        cont.resume(returning: result)
    }

    // MARK: - Internal methods called by delegate

    func handleConnectAck(_ mqtt: CocoaMQTT5, ack: CocoaMQTTCONNACKReasonCode) {
        NSLog("[Pairing] didConnectAck: \(ack.rawValue) - \(ack)")
        guard ack == .success else {
            fail(PairingError.connectionFailed("CONNACK: \(ack.rawValue) - \(ack)"))
            return
        }
        NSLog("[Pairing] Subscribing to teamclaw/pairing/\(code)")
        mqtt.subscribe("teamclaw/pairing/\(code)", qos: .qos1)
    }

    func handleMessage(_ mqtt: CocoaMQTT5, message: CocoaMQTT5Message) {
        guard let jsonString = message.string,
              let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        let topic = message.topic
        let parts = topic.split(separator: "/")

        // Pairing credentials response: {"status":"paired", "mqtt_host":..., ...}
        if let status = json["status"] as? String, status == "paired",
           let host    = json["mqtt_host"]           as? String,
           let portNum = json["mqtt_port"]           as? Int,
           let uname   = json["mqtt_username"]       as? String,
           let pwd     = json["mqtt_password"]       as? String,
           let tID     = json["team_id"]             as? String,
           let dName   = json["desktop_device_name"] as? String {

            let desktopDeviceID = (json["desktop_device_id"] as? String) ?? discoveredDesktopDeviceID ?? ""
            let result = PairingResult(
                host: host,
                port: UInt16(portNum),
                username: uname,
                password: pwd,
                teamID: tID,
                desktopDeviceID: desktopDeviceID,
                desktopName: dName
            )
            succeed(result)
            return
        }

        // Discovery message: teamclaw/pairing/{code} → {"team_id":..., "device_id":...}
        if parts.count == 3 && parts[0] == "teamclaw" && parts[1] == "pairing" {
            guard let teamID   = json["team_id"]  as? String,
                  let deviceID = json["device_id"] as? String
            else { return }

            guard discoveredTeamID == nil else { return }
            discoveredTeamID = teamID
            discoveredDesktopDeviceID = deviceID

            // Publish pair request back to the same topic
            let pairingTopic = "teamclaw/pairing/\(code)"
            let request: [String: String] = [
                "device_id":   mobileDeviceID,
                "device_name": mobileDeviceName
            ]
            if let payload = try? JSONSerialization.data(withJSONObject: request),
               let payloadStr = String(data: payload, encoding: .utf8) {
                let properties = MqttPublishProperties()
                mqtt.publish(pairingTopic, withString: payloadStr, qos: .qos1, DUP: false, retained: false, properties: properties)
            }
        }
    }

    func handleDisconnect(_ error: Error?) {
        NSLog("[Pairing] Disconnected, error: \(String(describing: error))")
        if let err = error {
            fail(PairingError.connectionFailed(err.localizedDescription))
        } else {
            fail(PairingError.connectionFailed("服务器断开连接"))
        }
    }
}

// MARK: - PairingMQTTDelegate

/// NSObject delegate to handle CocoaMQTT5 callbacks and forward to PairingService actor
private final class PairingMQTTDelegate: NSObject, CocoaMQTT5Delegate {
    weak var service: PairingService?

    init(service: PairingService) {
        self.service = service
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didConnectAck ack: CocoaMQTTCONNACKReasonCode, connAckData: MqttDecodeConnAck?) {
        Task { [weak self] in
            await self?.service?.handleConnectAck(mqtt5, ack: ack)
        }
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveMessage message: CocoaMQTT5Message, id: UInt16, publishData: MqttDecodePublish?) {
        Task { [weak self] in
            await self?.service?.handleMessage(mqtt5, message: message)
        }
    }

    func mqtt5DidDisconnect(_ mqtt5: CocoaMQTT5, withError err: Error?) {
        Task { [weak self] in
            await self?.service?.handleDisconnect(err)
        }
    }

    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishMessage message: CocoaMQTT5Message, id: UInt16) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishAck id: UInt16, pubAckData: MqttDecodePubAck?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didPublishRec id: UInt16, pubRecData: MqttDecodePubRec?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didSubscribeTopics success: NSDictionary, failed: [String], subAckData: MqttDecodeSubAck?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didUnsubscribeTopics topics: [String], unsubAckData: MqttDecodeUnsubAck?) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveDisconnectReasonCode reasonCode: CocoaMQTTDISCONNECTReasonCode) {}
    func mqtt5(_ mqtt5: CocoaMQTT5, didReceiveAuthReasonCode reasonCode: CocoaMQTTAUTHReasonCode) {}
    func mqtt5DidPing(_ mqtt5: CocoaMQTT5) {}
    func mqtt5DidReceivePong(_ mqtt5: CocoaMQTT5) {}
}

// MARK: - PairingError

enum PairingError: LocalizedError {
    case timeout
    case connectionFailed(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .timeout:               return "配对超时，请确认桌面端已生成配对码并保持连接"
        case .connectionFailed(let msg): return "连接失败：\(msg)"
        case .cancelled:             return "配对已取消"
        }
    }
}
