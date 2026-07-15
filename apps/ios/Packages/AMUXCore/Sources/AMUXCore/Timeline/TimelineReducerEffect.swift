import Foundation

/// Result of one `ChatTimelineReducer.apply(_:to:)` call. The view-model
/// uses this to decide whether to re-sort `state.entries`, run the SwiftData
/// projection (`TimelineSwiftDataSync.sync`), and call `recomputeGroups()`.
/// Streaming-delta hot paths return `.streamingBufferOnly` so the VM can skip
/// the O(N log N) sort and O(N) projection entirely on every token.
public enum TimelineReducerEffect: Equatable {
    /// Dedupe / orphan / no-op input — no state mutated.
    case noop

    /// Only the reducer-owned streaming buffers changed
    /// (`streamingTextByAgent`, `streamingModelByAgent`,
    /// `streamingAgentSet`, `streamingTurnIDByAgent`, or
    /// `availableCommands`). `state.entries` is byte-identical.
    case streamingBufferOnly

    /// `state.entries` was added to, removed from, or mutated in place.
    /// Callers must re-sort + re-project to SwiftData.
    case entriesChanged
}
