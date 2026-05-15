import Foundation
import Observation
import CocoaMQTT

public enum ConnectionState: String, Sendable {
    case disconnected, connecting, connected, reconnecting
}

public struct MQTTIncoming: Sendable {
    public let topic: String
    public let payload: Data
    public let retained: Bool
}

@Observable
public final class MQTTService: NSObject, @unchecked Sendable {
    typealias TopicHook = @Sendable (String) async throws -> Void

    public private(set) var connectionState: ConnectionState = .disconnected
    private var mqtt: CocoaMQTT?
    private let subscribeHook: TopicHook?
    private let unsubscribeHook: TopicHook?
    private let publishHook: (@Sendable (String, Data, Bool) async throws -> Void)?
    private let recordTopicOperations: Bool
    internal private(set) var subscribedTopics: [String] = []
    internal private(set) var unsubscribedTopics: [String] = []

    /// Serialises access to `continuations` and `connectContinuation`.
    /// Previously an `NSLock`, which deadlocked the main thread on back-button
    /// dismiss: `disconnect()` held the lock while finishing each continuation,
    /// `finish()` synchronously invoked the per-continuation `onTermination`
    /// closure, which then tried to re-acquire the non-reentrant `NSLock` on
    /// the same thread → hang (see Sentry TEAMCLAW-IOS-2). A serial dispatch
    /// queue sidesteps the reentrance problem entirely: even if the closure
    /// is invoked on a thread currently waiting on the queue, the cleanup is
    /// dispatched (`async`) and runs after the current task completes.
    private let stateQueue = DispatchQueue(label: "tech.teamclaw.mqtt-service.state")
    private var continuations: [UUID: AsyncStream<MQTTIncoming>.Continuation] = [:]
    private var connectContinuation: CheckedContinuation<Void, Error>?
    private var subscribeContinuations: [String: [CheckedContinuation<Void, Error>]] = [:]

    public override init() {
        subscribeHook = nil
        unsubscribeHook = nil
        publishHook = nil
        recordTopicOperations = false
        super.init()
    }

    internal init(
        subscribeHook: TopicHook? = nil,
        unsubscribeHook: TopicHook? = nil,
        publishHook: (@Sendable (String, Data, Bool) async throws -> Void)? = nil
    ) {
        self.subscribeHook = subscribeHook
        self.unsubscribeHook = unsubscribeHook
        self.publishHook = publishHook
        self.recordTopicOperations = true
        super.init()
        if subscribeHook != nil || unsubscribeHook != nil || publishHook != nil {
            connectionState = .connected
        }
    }

    public func connect(
        host: String, port: Int,
        username: String, password: String,
        clientId: String, useTLS: Bool
    ) async throws {
        connectionState = .connecting

        let mqtt = CocoaMQTT(clientID: clientId, host: host, port: UInt16(port))
        mqtt.username = username
        mqtt.password = password
        mqtt.keepAlive = 90
        mqtt.enableSSL = useTLS
        mqtt.allowUntrustCACertificate = true
        mqtt.delegate = self
        self.mqtt = mqtt

        // Race the CONNACK against a 15 s timeout — without this, a dead
        // socket that never yields a delegate callback would leave the
        // continuation unresumed forever, and the caller-side isConnecting
        // flag with it. Reported symptom: "Not Connected" sticks, tap
        // reconnect does nothing, only kill+relaunch recovers.
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await self.waitForConnectAck(mqtt: mqtt)
            }
            group.addTask {
                try await Task.sleep(for: .seconds(15))
                // Timeout fires: drain the pending continuation so the
                // CONNACK arm (if it ever returns) doesn't try to resume
                // a stale one.
                if let pending = self.takeConnectContinuation() {
                    pending.resume(throwing: MQTTConnectionError.timeout)
                }
                throw MQTTConnectionError.timeout
            }
            try await group.next()
            group.cancelAll()
        }
    }

    private func waitForConnectAck(mqtt: CocoaMQTT) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // Publish the continuation to state BEFORE calling connect() so
            // a fast CONNACK on the delegate thread finds it installed.
            stateQueue.sync {
                self.connectContinuation = continuation
            }
            let ok = mqtt.connect()
            if !ok {
                if let pending = takeConnectContinuation() {
                    pending.resume(throwing: MQTTConnectionError.connectFailed)
                }
            }
        }
    }

    public func disconnect() async {
        mqtt?.disconnect()
        mqtt = nil
        connectionState = .disconnected
        // Snapshot + drain OUTSIDE the critical section; each `finish()`
        // triggers `onTermination`, which itself dispatches back to the
        // queue — we must not be in the queue when that happens.
        let conts: [AsyncStream<MQTTIncoming>.Continuation] = stateQueue.sync {
            let snapshot = Array(continuations.values)
            continuations.removeAll()
            return snapshot
        }
        for c in conts { c.finish() }
    }

    public func subscribe(_ topic: String) async throws {
        if let subscribeHook {
            try await subscribeHook(topic)
            if recordTopicOperations {
                subscribedTopics.append(topic)
            }
            return
        }
        guard let mqtt, connectionState == .connected else {
            throw MQTTConnectionError.notConnected
        }
        try await waitForSubscribeAck(topic: topic, mqtt: mqtt)
        if recordTopicOperations {
            subscribedTopics.append(topic)
        }
    }

    public func unsubscribe(_ topic: String) async throws {
        if let unsubscribeHook {
            try await unsubscribeHook(topic)
            if recordTopicOperations {
                unsubscribedTopics.append(topic)
            }
            return
        }
        guard let mqtt, connectionState == .connected else {
            throw MQTTConnectionError.notConnected
        }
        mqtt.unsubscribe(topic)
        if recordTopicOperations {
            unsubscribedTopics.append(topic)
        }
    }

    internal func unsubscribeForLifecycleStop(_ topic: String) {
        if let unsubscribeHook {
            Task {
                try? await unsubscribeHook(topic)
                if self.recordTopicOperations {
                    self.unsubscribedTopics.append(topic)
                }
            }
            return
        }
        guard let mqtt, connectionState == .connected else {
            return
        }
        mqtt.unsubscribe(topic)
        if recordTopicOperations {
            unsubscribedTopics.append(topic)
        }
    }

    public func publish(topic: String, payload: Data, retain: Bool = false) async throws {
        if let publishHook {
            try await publishHook(topic, payload, retain)
            return
        }
        guard let mqtt, connectionState == .connected else {
            throw MQTTConnectionError.notConnected
        }
        let message = CocoaMQTTMessage(topic: topic, payload: [UInt8](payload), qos: .qos1, retained: retain)
        mqtt.publish(message)
    }

    /// Inbound message stream. Internal access: only `MQTTMessageHub`
    /// should call this in production code. Other consumers must route
    /// through the hub so we have a single point of fan-out, dedupe, and
    /// reconnect handling.
    internal func messages() -> AsyncStream<MQTTIncoming> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<MQTTIncoming>.makeStream()
        stateQueue.async {
            self.continuations[id] = continuation
        }
        continuation.onTermination = { [weak self] _ in
            // Dispatch async so the cancelling thread (often the main actor
            // during a view-dismiss Task cancellation) never blocks waiting
            // on the queue.
            self?.stateQueue.async {
                self?.continuations.removeValue(forKey: id)
            }
        }
        return stream
    }

    private func broadcast(_ msg: MQTTIncoming) {
        let conts: [AsyncStream<MQTTIncoming>.Continuation] = stateQueue.sync {
            Array(continuations.values)
        }
        for c in conts {
            c.yield(msg)
        }
    }

    /// Test-only helper: pushes an incoming MQTT message into all active
    /// `messages()` AsyncStream continuations. Use from XCTest with
    /// `@testable import AMUXCore`. Not safe for production code paths.
    internal func deliverForTesting(_ msg: MQTTIncoming) {
        broadcast(msg)
    }

    /// Atomically consumes `connectContinuation` — ensures only the first
    /// caller (whether the CONNACK delegate, the immediate-false return in
    /// `connect()`, or an unexpected mid-handshake `mqttDidDisconnect`) gets
    /// to resume the stored continuation.
    fileprivate func takeConnectContinuation() -> CheckedContinuation<Void, Error>? {
        stateQueue.sync {
            let c = connectContinuation
            connectContinuation = nil
            return c
        }
    }

    private func waitForSubscribeAck(topic: String, mqtt: CocoaMQTT) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    self.stateQueue.sync {
                        self.subscribeContinuations[topic, default: []].append(continuation)
                    }
                    mqtt.subscribe(topic, qos: .qos1)
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                if let pending = self.takeSubscribeContinuation(for: topic) {
                    pending.resume(throwing: MQTTConnectionError.subscribeTimeout(topic))
                }
                throw MQTTConnectionError.subscribeTimeout(topic)
            }

            let result = try await group.next()
            group.cancelAll()
            _ = result
        }
    }

    fileprivate func takeSubscribeContinuation(for topic: String) -> CheckedContinuation<Void, Error>? {
        stateQueue.sync {
            guard var pending = subscribeContinuations[topic], !pending.isEmpty else {
                return nil
            }
            let continuation = pending.removeFirst()
            if pending.isEmpty {
                subscribeContinuations.removeValue(forKey: topic)
            } else {
                subscribeContinuations[topic] = pending
            }
            return continuation
        }
    }

    fileprivate func takeAllSubscribeContinuations() -> [CheckedContinuation<Void, Error>] {
        stateQueue.sync {
            let pending = subscribeContinuations.values.flatMap { $0 }
            subscribeContinuations.removeAll()
            return pending
        }
    }

    enum MQTTConnectionError: Error, LocalizedError {
        case connectFailed
        case timeout
        case notConnected
        case subscribeTimeout(String)
        var errorDescription: String? {
            switch self {
            case .connectFailed: "MQTT connection initiation failed"
            case .timeout: "MQTT connection timed out"
            case .notConnected: "MQTT is not connected"
            case .subscribeTimeout(let topic): "MQTT subscribe timed out for \(topic)"
            }
        }
    }
}

// MARK: - CocoaMQTTDelegate

extension MQTTService: CocoaMQTTDelegate {
    public func mqtt(_ mqtt: CocoaMQTT, didConnectAck ack: CocoaMQTTConnAck) {
        let pending = takeConnectContinuation()
        if ack == .accept {
            connectionState = .connected
            pending?.resume()
        } else {
            connectionState = .disconnected
            pending?.resume(throwing: MQTTConnectionError.connectFailed)
        }
    }

    public func mqtt(_ mqtt: CocoaMQTT, didPublishMessage message: CocoaMQTTMessage, id: UInt16) {}
    public func mqtt(_ mqtt: CocoaMQTT, didPublishAck id: UInt16) {}

    public func mqtt(_ mqtt: CocoaMQTT, didReceiveMessage message: CocoaMQTTMessage, id: UInt16) {
        let incoming = MQTTIncoming(
            topic: message.topic,
            payload: Data(message.payload),
            retained: message.retained
        )
        broadcast(incoming)
    }

    public func mqtt(_ mqtt: CocoaMQTT, didSubscribeTopics success: NSDictionary, failed: [String]) {
        for key in success.allKeys {
            guard let topic = key as? String,
                  let pending = takeSubscribeContinuation(for: topic) else {
                continue
            }
            pending.resume()
        }
        for topic in failed {
            takeSubscribeContinuation(for: topic)?
                .resume(throwing: MQTTConnectionError.subscribeTimeout(topic))
        }
    }
    public func mqtt(_ mqtt: CocoaMQTT, didUnsubscribeTopics topics: [String]) {}

    public func mqttDidPing(_ mqtt: CocoaMQTT) {}
    public func mqttDidReceivePong(_ mqtt: CocoaMQTT) {}

    public func mqttDidDisconnect(_ mqtt: CocoaMQTT, withError err: (any Error)?) {
        connectionState = .disconnected
        if let pending = takeConnectContinuation() {
            pending.resume(throwing: err ?? MQTTConnectionError.connectFailed)
        }
        let subscribeError = err ?? MQTTConnectionError.connectFailed
        for pending in takeAllSubscribeContinuations() {
            pending.resume(throwing: subscribeError)
        }
    }

    public func mqtt(_ mqtt: CocoaMQTT, didStateChangeTo state: CocoaMQTTConnState) {}
    public func mqtt(_ mqtt: CocoaMQTT, didReceive trust: SecTrust, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }
}
