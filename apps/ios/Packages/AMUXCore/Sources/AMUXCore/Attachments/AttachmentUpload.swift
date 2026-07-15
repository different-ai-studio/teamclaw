import Foundation
import SwiftData

/// Tracks a single file upload from composer to Supabase Storage.
/// Lifecycle: pending → uploading → completed (or failed).
/// Persists across app relaunch so uploads resume on return.
@Model
public final class AttachmentUpload {
    /// Unique attachment ID; used in Storage path.
    @Attribute(.unique) public var attachmentID: String

    /// Foreign key to OutboxMessage. One message may have many attachments.
    public var messageID: String

    /// Session ID for Storage path organization.
    public var sessionID: String

    /// Original filename (for display and Storage path).
    public var fileName: String

    /// File size in bytes (for validation and progress reporting).
    public var fileSize: Int64

    /// Raw upload state (pending | uploading | completed | failed).
    /// Use computed property `uploadState` for type-safe access.
    public var uploadStateRaw: String

    /// Bytes uploaded so far; used for progress reporting.
    public var uploadedBytes: Int64 = 0

    /// Supabase Storage URL after successful upload.
    public var storageURL: String?

    /// Error message if upload failed (for user-facing error display).
    public var uploadError: String?

    /// Creation timestamp.
    public var createdAt: Date

    public init(
        attachmentID: String,
        messageID: String,
        sessionID: String,
        fileName: String,
        fileSize: Int64
    ) {
        self.attachmentID = attachmentID
        self.messageID = messageID
        self.sessionID = sessionID
        self.fileName = fileName
        self.fileSize = fileSize
        self.uploadStateRaw = UploadState.pending.rawValue
        self.createdAt = .now
    }

    /// Type-safe access to upload state.
    public var uploadState: UploadState {
        get { UploadState(rawValue: uploadStateRaw) ?? .pending }
        set { uploadStateRaw = newValue.rawValue }
    }

    /// Progress as fraction 0.0...1.0.
    public var progress: Double {
        guard fileSize > 0 else { return 0 }
        return Double(uploadedBytes) / Double(fileSize)
    }
}
