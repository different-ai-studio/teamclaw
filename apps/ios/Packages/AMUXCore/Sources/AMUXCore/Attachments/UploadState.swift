import Foundation

/// Lifecycle of an attachment queued for upload.
///
/// `pending` attachments are visible to `AttachmentUploadManager` once
/// they are enqueued for upload. The manager flips them to `uploading` while
/// the multipart file transfer to the storage backend is in progress, then to
/// `completed` (success) or `failed` (network error, server error, or
/// cancellation). Once an upload enters `failed`, it may be retried via explicit
/// user action or automatic retry logic with backoff.
///
/// Valid state transitions:
/// - `pending` → `uploading` (upload starts)
/// - `uploading` → `completed` (success)
/// - `uploading` → `failed` (network/server error or cancelled)
/// - `failed` → `uploading` (retry initiated)
///
/// State is managed by `AttachmentUploadManager` as the multipart upload progresses.
public enum UploadState: String, Sendable, Codable {
    case pending     // queued, not yet started
    case uploading   // in progress
    case completed   // successfully uploaded
    case failed      // upload failed or cancelled
}
