import Foundation

public protocol PresenceWriter: Sendable {
    func writeForeground(deviceID: String, until: Date) async throws
}

@MainActor
public final class PresenceHeartbeat {
    private let writer: PresenceWriter
    private let deviceID: String
    private var task: Task<Void, Never>?
    private let intervalSec: TimeInterval = 20
    private let leaseSec: TimeInterval = 45

    public init(writer: PresenceWriter, deviceID: String) {
        self.writer = writer
        self.deviceID = deviceID
    }

    public func enterForeground() {
        task?.cancel()
        let writer = self.writer
        let did = self.deviceID
        let interval = self.intervalSec
        let lease = self.leaseSec
        task = Task { @MainActor in
            while !Task.isCancelled {
                try? await writer.writeForeground(
                    deviceID: did, until: Date().addingTimeInterval(lease))
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    public func enterBackground() {
        task?.cancel()
        Task { @MainActor in
            try? await writer.writeForeground(
                deviceID: deviceID, until: Date())
        }
    }
}
