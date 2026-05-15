package tech.teamclaw.android.core.auth

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import tech.teamclaw.android.core.model.WorkspaceRecord

interface WorkspaceRepository {
    suspend fun listWorkspaces(teamId: String, agentId: String? = null): List<WorkspaceRecord>
}

class SupabaseWorkspaceRepository(
    private val client: SupabaseClient,
) : WorkspaceRepository {

    override suspend fun listWorkspaces(teamId: String, agentId: String?): List<WorkspaceRecord> {
        val rows: List<WorkspaceRow> = client.postgrest.from("workspaces")
            .select(columns = Columns.list("id", "team_id", "agent_id", "path", "name")) {
                filter {
                    eq("team_id", teamId)
                    if (!agentId.isNullOrBlank()) {
                        eq("agent_id", agentId)
                    }
                }
                order(column = "name", order = io.github.jan.supabase.postgrest.query.Order.ASCENDING)
            }
            .decodeList()

        return rows.map {
            WorkspaceRecord(
                id = it.id,
                teamId = it.teamId,
                agentId = it.agentId,
                path = it.path.orEmpty(),
                displayName = it.name,
            )
        }
    }

    @Serializable
    private data class WorkspaceRow(
        val id: String,
        @SerialName("team_id") val teamId: String,
        @SerialName("agent_id") val agentId: String?,
        val path: String?,
        val name: String,
    )
}
