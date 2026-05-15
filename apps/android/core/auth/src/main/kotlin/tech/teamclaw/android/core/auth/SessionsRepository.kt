package tech.teamclaw.android.core.auth

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import tech.teamclaw.android.core.model.SessionRecord

interface SessionsRepository {
    suspend fun listSessions(teamId: String): List<SessionRecord>
}

class SupabaseSessionsRepository(
    private val client: SupabaseClient,
) : SessionsRepository {

    override suspend fun listSessions(teamId: String): List<SessionRecord> {
        val sessionRows: List<SessionRow> = client.postgrest.from("sessions")
            .select(
                columns = Columns.list(
                    "id", "team_id", "idea_id", "created_by_actor_id", "primary_agent_id",
                    "mode", "title", "summary", "last_message_preview", "last_message_at", "created_at",
                ),
            ) {
                filter { eq("team_id", teamId) }
                order(column = "last_message_at", order = Order.DESCENDING)
            }
            .decodeList()

        if (sessionRows.isEmpty()) return emptyList()
        val sessionIds = sessionRows.map { it.id }

        val participantRows: List<ParticipantRow> = client.postgrest.from("session_participants")
            .select(columns = Columns.list("session_id")) {
                filter { isIn("session_id", sessionIds) }
            }
            .decodeList()

        val counts = participantRows.groupingBy { it.sessionId }.eachCount()

        return sessionRows.map { row ->
            SessionRecord(
                id = row.id,
                teamId = row.teamId,
                ideaId = row.ideaId,
                createdByActorId = row.createdByActorId,
                primaryAgentId = row.primaryAgentId,
                mode = row.mode.orEmpty(),
                title = row.title.orEmpty(),
                summary = row.summary.orEmpty(),
                participantCount = counts[row.id] ?: 0,
                lastMessagePreview = row.lastMessagePreview.orEmpty(),
                lastMessageAtMs = row.lastMessageAt?.toEpochMillis(),
                createdAtMs = row.createdAt.toEpochMillis(),
            )
        }
    }

    private fun Instant.toEpochMillis(): Long = toEpochMilliseconds()

    @Serializable
    private data class SessionRow(
        val id: String,
        @SerialName("team_id") val teamId: String,
        @SerialName("idea_id") val ideaId: String?,
        @SerialName("created_by_actor_id") val createdByActorId: String,
        @SerialName("primary_agent_id") val primaryAgentId: String?,
        val mode: String?,
        val title: String?,
        val summary: String?,
        @SerialName("last_message_preview") val lastMessagePreview: String?,
        @SerialName("last_message_at") val lastMessageAt: Instant?,
        @SerialName("created_at") val createdAt: Instant,
    )

    @Serializable
    private data class ParticipantRow(
        @SerialName("session_id") val sessionId: String,
    )
}
