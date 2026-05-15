package tech.teamclaw.android.core.auth

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import tech.teamclaw.android.core.model.SessionRecord

@OptIn(ExperimentalCoroutinesApi::class)
class SessionListStoreTest {

    private class FakeSessionsRepo(
        var rows: List<SessionRecord> = emptyList(),
        var error: Throwable? = null,
    ) : SessionsRepository {
        var calls = 0
        override suspend fun listSessions(teamId: String): List<SessionRecord> {
            calls++
            error?.let { throw it }
            return rows
        }
    }

    private fun sample(id: String) = SessionRecord(
        id = id, teamId = "T", ideaId = null, createdByActorId = "a",
        primaryAgentId = null, mode = "chat", title = "Session $id",
        summary = "", participantCount = 1, lastMessagePreview = "",
        lastMessageAtMs = null, createdAtMs = 0L,
    )

    @Test fun `reload populates sessions on success`() = runTest {
        val repo = FakeSessionsRepo(rows = listOf(sample("1"), sample("2")))
        val store = SessionListStore("T", repo)

        store.reload()

        assertThat(store.state.value.sessions.map { it.id }).containsExactly("1", "2").inOrder()
        assertThat(store.state.value.isLoading).isFalse()
        assertThat(store.state.value.errorMessage).isNull()
    }

    @Test fun `reload surfaces error and clears loading`() = runTest {
        val repo = FakeSessionsRepo(error = RuntimeException("network down"))
        val store = SessionListStore("T", repo)

        store.reload()

        assertThat(store.state.value.errorMessage).contains("network down")
        assertThat(store.state.value.isLoading).isFalse()
    }
}
