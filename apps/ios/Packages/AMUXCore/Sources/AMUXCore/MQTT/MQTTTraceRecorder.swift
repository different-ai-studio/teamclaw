import Foundation

/// One on-disk record line. Stored as JSONL so traces are append-only,
/// streamable, and trivially diffable. Payloads are base64 because the
/// underlying MQTT bytes are protobuf (not text); decoding them back to
/// the original `MQTTIncoming` is a single base64 + Data round-trip.
public struct MQTTTraceRecord: Codable, Equatable, Sendable {
    public let topic: String
    public let payloadBase64: String
    public let retained: Bool
    public let recordedAt: Date

    public init(topic: String, payloadBase64: String, retained: Bool, recordedAt: Date) {
        self.topic = topic
        self.payloadBase64 = payloadBase64
        self.retained = retained
        self.recordedAt = recordedAt
    }

    /// Round-trip helper: rebuild an `MQTTIncoming` from this record.
    /// Tests / fixture replays use this to feed recorded sessions back
    /// through the reducer.
    public func asIncoming() -> MQTTIncoming? {
        guard let data = Data(base64Encoded: payloadBase64) else { return nil }
        return MQTTIncoming(topic: topic, payload: data, retained: retained)
    }
}

/// Actor-isolated JSONL writer for captured MQTT traffic. Designed for
/// Phase 4 fixture capture: enable, drive a real session, copy the
/// resulting file out of the sandbox, replay through `ChatTimelineReducer`
/// in a test.
///
/// ## Usage
///
/// ```swift
/// let url = URL.documentsDirectory.appendingPathComponent("teamclaw-trace.jsonl")
/// let recorder = MQTTTraceRecorder(fileURL: url)
/// await recorder.start()
/// // pass into MQTTMessageHub; every fanout will write a record
/// await recorder.record(incoming)
/// await recorder.close()
/// ```
///
/// Off by default in production. The hub picks the recorder up via
/// `MQTTMessageHub.attachRecorder` when the user opts in (today: setting
/// `UserDefaults.standard.set(true, forKey: "TeamclawRecordMQTT")` before
/// launching the app).
public actor MQTTTraceRecorder {
    public let fileURL: URL
    private var handle: FileHandle?
    /// `JSONEncoder` is value-type and Sendable; we re-create it lazily
    /// rather than holding it as state to keep the actor's stored
    /// surface small.

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// Open the file for writing, creating it if absent. Subsequent
    /// `record` calls append; reopening across app launches preserves
    /// the prior trace until the caller explicitly truncates.
    public func start() throws {
        if handle != nil { return }
        let fm = FileManager.default
        if !fm.fileExists(atPath: fileURL.path) {
            try? fm.createDirectory(at: fileURL.deletingLastPathComponent(),
                                    withIntermediateDirectories: true)
            fm.createFile(atPath: fileURL.path, contents: nil)
        }
        let h = try FileHandle(forWritingTo: fileURL)
        try h.seekToEnd()
        self.handle = h
    }

    /// Write one record. Encoding failures and write failures are
    /// silently swallowed — the recorder is a debug aid; an MQTT trace
    /// gap is preferable to a crash on a malformed message.
    public func record(_ msg: MQTTIncoming) {
        guard let handle else { return }
        let record = MQTTTraceRecord(
            topic: msg.topic,
            payloadBase64: msg.payload.base64EncodedString(),
            retained: msg.retained,
            recordedAt: Date()
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let line = try? encoder.encode(record) else { return }
        do {
            try handle.write(contentsOf: line)
            try handle.write(contentsOf: Data([0x0A])) // \n
            // fsync per record so the trace survives a kill at the
            // end of a UI test — the app process exits before any
            // tearDown / close call we'd otherwise rely on.
            try handle.synchronize()
        } catch {
            // Ignored: see method-level doc comment.
        }
    }

    public func close() {
        try? handle?.synchronize()
        try? handle?.close()
        handle = nil
    }

    /// True once `start()` has succeeded and the file handle is live.
    public func isActive() -> Bool {
        handle != nil
    }
}
