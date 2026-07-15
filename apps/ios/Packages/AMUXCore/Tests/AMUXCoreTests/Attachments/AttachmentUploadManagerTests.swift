import XCTest
import SwiftData
@testable import AMUXCore

final class AttachmentUploadManagerTests: XCTestCase {
    var modelContainer: ModelContainer!
    var modelContext: ModelContext!
    var uploadManager: AttachmentUploadManager!

    override func setUp() async throws {
        try await super.setUp()

        // Create in-memory SwiftData container for tests
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        modelContainer = try ModelContainer(for: AttachmentUpload.self, configurations: config)
        modelContext = ModelContext(modelContainer)

        // Cloud API client with a stub transport that fails the upload — these
        // tests exercise record creation / state transitions / size + file
        // guards, not a real upload round-trip.
        let configuration = CloudAPIConfiguration(
            baseURL: URL(string: "https://test.cloud.example")!
        )
        let client = CloudAPIClient(
            configuration: configuration,
            accessToken: { "test-token" },
            send: { _ in
                (Data("{\"error\":{\"code\":\"x\",\"message\":\"stub\"}}".utf8),
                 HTTPURLResponse(url: URL(string: "https://test.cloud.example")!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
            }
        )
        uploadManager = AttachmentUploadManager(
            modelContext: modelContext,
            client: client
        )
    }

    func testStartUploadCreatesRecord() async throws {
        let tempFile = try createTempFile(size: 1024)

        let upload = try await uploadManager.startUpload(
            filePath: tempFile,
            messageID: "msg-1",
            sessionID: "sess-1",
            teamID: "team-1"
        )

        XCTAssertEqual(upload.uploadState, .pending)
        XCTAssertEqual(upload.messageID, "msg-1")
        XCTAssertEqual(upload.fileName, tempFile.lastPathComponent)
    }

    func testFileTooLargeThrows() async throws {
        let tempFile = try createTempFile(size: 60_000_000) // 60MB

        do {
            _ = try await uploadManager.startUpload(
                filePath: tempFile,
                messageID: "msg-1",
                sessionID: "sess-1",
                teamID: "team-1"
            )
            XCTFail("Should have thrown fileTooLarge")
        } catch UploadError.fileTooLarge {
            // Expected
        }
    }

    func testProgressCalculatesCorrectly() {
        let upload = AttachmentUpload(
            attachmentID: "att-1",
            messageID: "msg-1",
            sessionID: "sess-1",
            fileName: "test.txt",
            fileSize: 1000
        )

        upload.uploadedBytes = 500
        XCTAssertEqual(upload.progress, 0.5)

        upload.uploadedBytes = 0
        XCTAssertEqual(upload.progress, 0.0)

        upload.uploadedBytes = 1000
        XCTAssertEqual(upload.progress, 1.0)

        // Test edge case: fileSize == 0
        upload.fileSize = 0
        XCTAssertEqual(upload.progress, 0.0)
    }

    func testUploadStateTransitionsDuringUpload() async throws {
        let tempFile = try createTempFile(size: 5_000)

        let upload = try await uploadManager.startUpload(
            filePath: tempFile,
            messageID: "msg-1",
            sessionID: "sess-1",
            teamID: "team-1"
        )

        // Record is created in pending state
        XCTAssertEqual(upload.uploadState, .pending)

        // Wait briefly for async upload task to start
        try await Task.sleep(nanoseconds: 100_000_000)  // 100ms

        // Fetch the updated record from SwiftData to see state changes
        let descriptor = FetchDescriptor<AttachmentUpload>()
        let updated = try modelContext.fetch(descriptor)
        guard let finalUpload = updated.first(where: { $0.attachmentID == upload.attachmentID }) else {
            XCTFail("Upload record not found after async operation")
            return
        }

        // State should have progressed (uploading or beyond)
        XCTAssertNotEqual(finalUpload.uploadState, .pending, "State should have changed from pending")
    }

    func testRetryUploadFetchesRecord() async throws {
        let tempFile = try createTempFile(size: 1024)

        // Create an upload record
        let upload = try await uploadManager.startUpload(
            filePath: tempFile,
            messageID: "msg-1",
            sessionID: "sess-1",
            teamID: "team-1"
        )

        let attachmentID = upload.attachmentID

        // Simulate failure by manually setting state
        upload.uploadState = .failed
        upload.uploadError = "Network error"
        try? modelContext.save()

        // Retry should succeed (in a real test, would mock network success)
        do {
            try await uploadManager.retryUpload(
                attachmentID: attachmentID,
                filePath: tempFile,
                teamID: "team-1"
            )
            // Verify the fetch worked (no exception thrown)
            XCTAssertTrue(true)
        } catch UploadError.attachmentNotFound {
            XCTFail("retryUpload should have found the existing record")
        }
    }

    func testFileNotFoundThrows() async throws {
        let nonExistentFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("nonexistent-\(UUID().uuidString).bin")

        do {
            _ = try await uploadManager.startUpload(
                filePath: nonExistentFile,
                messageID: "msg-1",
                sessionID: "sess-1",
                teamID: "team-1"
            )
            XCTFail("Should have thrown error for nonexistent file")
        } catch {
            // Expected: file read should fail
            XCTAssertTrue(true)
        }
    }

    private func createTempFile(size: Int) throws -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "test-\(UUID().uuidString).bin"
        let url = tempDir.appendingPathComponent(fileName)

        let data = Data(repeating: 0xAB, count: size)
        try data.write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}

