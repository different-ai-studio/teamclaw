package tech.teamclaw.android.core.model

import kotlinx.serialization.Serializable

@Serializable
data class SessionRecord(
    val id: String,
    val teamId: String,
    val ideaId: String?,
    val createdByActorId: String,
    val primaryAgentId: String?,
    val mode: String,
    val title: String,
    val summary: String,
    val participantCount: Int,
    val lastMessagePreview: String,
    /** Unix-epoch millis. Null if no message yet. */
    val lastMessageAtMs: Long?,
    /** Unix-epoch millis. */
    val createdAtMs: Long,
)
