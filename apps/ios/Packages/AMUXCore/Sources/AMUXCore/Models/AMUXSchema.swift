import Foundation
import SwiftData

/// Canonical SwiftData schema for the app. Declaring this as a `VersionedSchema`
/// and passing it through a `SchemaMigrationPlan` stops SwiftData from falling
/// back to destructive migration when model shapes change.
///
/// Whenever you change the shape of ANY `@Model` class in this module:
/// 1. Snapshot the previous model shape into `AMUXSchemaV<N>`.
/// 2. Introduce a new schema version that points at the live models.
/// 3. Register a migration stage for the transition.
public enum AMUXSchemaV1: VersionedSchema {
    public static var versionIdentifier: Schema.Version { Schema.Version(1, 15, 0) }

    public static var models: [any PersistentModel.Type] {
        [
            Runtime.self,
            AgentEvent.self,
            CachedActor.self,
            CachedAgentRuntime.self,
            Workspace.self,
            Session.self,
            SessionMessage.self,
            SessionIdea.self,
            OutboxMessage.self,
            CachedShortcut.self,
            AttachmentUpload.self,
        ]
    }
}
