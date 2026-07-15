import XCTest
import SwiftData
@testable import AMUXCore

final class FileUploadIntegrationTests: XCTestCase {
    var modelContainer: ModelContainer!
    var modelContext: ModelContext!

    override func setUp() async throws {
        try await super.setUp()
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        modelContainer = try ModelContainer(
            for: OutboxMessage.self, AttachmentUpload.self,
            configurations: config
        )
        modelContext = ModelContext(modelContainer)
    }

    func testOutboxMessageWaitsForAttachment() async throws {
        // Create OutboxMessage
        let msg = OutboxMessage(
            messageID: "msg-1",
            sessionID: "sess-1",
            senderActorID: "user-1",
            content: "Here's a file",
            mentionActorIDs: [],
            modelID: nil
        )
        modelContext.insert(msg)

        // Create AttachmentUpload (pending)
        let upload = AttachmentUpload(
            attachmentID: "att-1",
            messageID: "msg-1",
            sessionID: "sess-1",
            fileName: "document.pdf",
            fileSize: 5_000_000
        )
        modelContext.insert(upload)

        msg.attachmentIDsJSON = try JSONEncoder()
            .encode(["att-1"])
            .utf8String ?? "[]"

        try modelContext.save()

        // Verify message thinks it's waiting for attachments
        let descriptor = FetchDescriptor<AttachmentUpload>(
            predicate: #Predicate { $0.messageID == "msg-1" }
        )
        let attachments = try modelContext.fetch(descriptor)
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(attachments[0].uploadState, .pending)

        // Simulate upload completing
        upload.uploadState = .completed
        upload.storageURL = "https://storage.example.com/attachments/team-1/sess-1/att-1/document.pdf"
        upload.uploadedBytes = upload.fileSize
        try modelContext.save()

        // Verify completion
        let updated = try modelContext.fetch(descriptor)
        XCTAssertTrue(updated[0].uploadState == .completed)
        XCTAssertNotNil(updated[0].storageURL)
    }

    func testMultipleAttachmentsTracking() async throws {
        let msg = OutboxMessage(
            messageID: "msg-2",
            sessionID: "sess-2",
            senderActorID: "user-1",
            content: "Multiple files",
            mentionActorIDs: [],
            modelID: nil
        )
        modelContext.insert(msg)

        // Create two attachments
        let att1 = AttachmentUpload(
            attachmentID: "att-1",
            messageID: "msg-2",
            sessionID: "sess-2",
            fileName: "file1.pdf",
            fileSize: 1_000_000
        )
        let att2 = AttachmentUpload(
            attachmentID: "att-2",
            messageID: "msg-2",
            sessionID: "sess-2",
            fileName: "file2.txt",
            fileSize: 500_000
        )
        modelContext.insert(att1)
        modelContext.insert(att2)

        msg.attachmentIDsJSON = try JSONEncoder()
            .encode(["att-1", "att-2"])
            .utf8String ?? "[]"

        try modelContext.save()

        // Verify both attachments tracked
        let descriptor = FetchDescriptor<AttachmentUpload>(
            predicate: #Predicate { $0.messageID == "msg-2" }
        )
        let attachments = try modelContext.fetch(descriptor)
        XCTAssertEqual(attachments.count, 2)

        // Mark first as completed, second as uploading
        att1.uploadState = .completed
        att1.uploadedBytes = att1.fileSize
        att2.uploadState = .uploading
        att2.uploadedBytes = 250_000  // 50% progress

        try modelContext.save()

        // Verify states
        let updated = try modelContext.fetch(descriptor)
        let completed = updated.filter { $0.uploadState == .completed }
        let uploading = updated.filter { $0.uploadState == .uploading }

        XCTAssertEqual(completed.count, 1)
        XCTAssertEqual(uploading.count, 1)
        XCTAssertEqual(uploading[0].progress, 0.5)
    }

    func testAttachmentProgressCalculation() {
        let upload = AttachmentUpload(
            attachmentID: "att-1",
            messageID: "msg-1",
            sessionID: "sess-1",
            fileName: "test.pdf",
            fileSize: 1000
        )

        upload.uploadedBytes = 0
        XCTAssertEqual(upload.progress, 0.0)

        upload.uploadedBytes = 500
        XCTAssertEqual(upload.progress, 0.5)

        upload.uploadedBytes = 1000
        XCTAssertEqual(upload.progress, 1.0)
    }

    func testAttachmentDecoding() throws {
        let msg = OutboxMessage(
            messageID: "msg-1",
            sessionID: "sess-1",
            senderActorID: "user-1",
            content: "Test",
            mentionActorIDs: [],
            modelID: nil
        )

        msg.attachmentIDsJSON = try JSONEncoder()
            .encode(["att-1", "att-2", "att-3"])
            .utf8String ?? "[]"

        let ids = msg.attachmentIDs
        XCTAssertEqual(ids.count, 3)
        XCTAssertEqual(ids[0], "att-1")
        XCTAssertEqual(ids[1], "att-2")
        XCTAssertEqual(ids[2], "att-3")
    }
}

extension Data {
    var utf8String: String? {
        String(data: self, encoding: .utf8)
    }
}
