import Testing
import Foundation
@testable import AMUXCore

@Suite("MQTTTraceRecorder")
struct MQTTTraceRecorderTests {

    private func tempURL() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("amux-trace-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("trace.jsonl")
    }

    @Test("start creates the file, record appends one JSONL line per message")
    func appendsJSONLines() async throws {
        let url = tempURL()
        let recorder = MQTTTraceRecorder(fileURL: url)
        try await recorder.start()

        await recorder.record(MQTTIncoming(topic: "amux/team/foo",
                                           payload: Data([0x01, 0x02, 0x03]),
                                           retained: false))
        await recorder.record(MQTTIncoming(topic: "amux/team/bar",
                                           payload: Data([0xFF]),
                                           retained: true))
        await recorder.close()

        let raw = try String(contentsOf: url, encoding: .utf8)
        let lines = raw.split(separator: "\n")
        #expect(lines.count == 2, "two records → two JSONL lines")

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let first = try decoder.decode(MQTTTraceRecord.self,
                                       from: Data(lines[0].utf8))
        #expect(first.topic == "amux/team/foo")
        #expect(first.retained == false)
        #expect(first.payloadBase64 == Data([0x01, 0x02, 0x03]).base64EncodedString())

        let second = try decoder.decode(MQTTTraceRecord.self,
                                        from: Data(lines[1].utf8))
        #expect(second.topic == "amux/team/bar")
        #expect(second.retained == true)
    }

    @Test("asIncoming round-trips the payload bytes")
    func asIncomingRoundTrip() {
        let record = MQTTTraceRecord(
            topic: "amux/x/y",
            payloadBase64: Data([0xDE, 0xAD, 0xBE, 0xEF]).base64EncodedString(),
            retained: true,
            recordedAt: .distantPast
        )
        let incoming = record.asIncoming()
        let unwrapped = try! #require(incoming)
        #expect(unwrapped.topic == "amux/x/y")
        #expect(unwrapped.retained == true)
        #expect(unwrapped.payload == Data([0xDE, 0xAD, 0xBE, 0xEF]))
    }

    @Test("record is a no-op before start() is called")
    func recordWithoutStartIsNoOp() async {
        let url = tempURL()
        let recorder = MQTTTraceRecorder(fileURL: url)
        // No start() call.
        await recorder.record(MQTTIncoming(topic: "x", payload: Data(), retained: false))
        // The file should NOT be created.
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test("re-opening across start/close calls appends rather than truncates")
    func reopenAppends() async throws {
        let url = tempURL()
        let recorder = MQTTTraceRecorder(fileURL: url)
        try await recorder.start()
        await recorder.record(MQTTIncoming(topic: "x", payload: Data(), retained: false))
        await recorder.close()

        try await recorder.start()
        await recorder.record(MQTTIncoming(topic: "y", payload: Data(), retained: false))
        await recorder.close()

        let raw = try String(contentsOf: url, encoding: .utf8)
        #expect(raw.split(separator: "\n").count == 2,
                "second session must append, not truncate")
    }
}
