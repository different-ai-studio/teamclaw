package tech.teamclaw.android.core.model

import kotlinx.serialization.Serializable

@Serializable
data class WorkspaceRecord(
    val id: String,
    val teamId: String,
    val agentId: String?,
    val path: String,
    val displayName: String,
)
