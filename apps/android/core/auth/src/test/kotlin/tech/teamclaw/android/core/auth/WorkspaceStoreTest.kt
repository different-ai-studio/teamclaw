package tech.teamclaw.android.core.auth

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import tech.teamclaw.android.core.model.WorkspaceRecord

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceStoreTest {

    private class FakeWorkspaceRepo(
        var rows: List<WorkspaceRecord> = emptyList(),
        var error: Throwable? = null,
    ) : WorkspaceRepository {
        override suspend fun listWorkspaces(teamId: String, agentId: String?): List<WorkspaceRecord> {
            error?.let { throw it }
            return rows
        }
    }

    private fun sample(id: String) = WorkspaceRecord(
        id = id, teamId = "T", agentId = null, path = "/tmp/$id", displayName = "WS $id",
    )

    @Test fun `reload populates workspaces`() = runTest {
        val repo = FakeWorkspaceRepo(rows = listOf(sample("1")))
        val store = WorkspaceStore("T", repo)

        store.reload()

        assertThat(store.state.value.workspaces).hasSize(1)
        assertThat(store.state.value.errorMessage).isNull()
    }

    @Test fun `reload surfaces error`() = runTest {
        val repo = FakeWorkspaceRepo(error = RuntimeException("rls denied"))
        val store = WorkspaceStore("T", repo)

        store.reload()

        assertThat(store.state.value.errorMessage).contains("rls denied")
    }
}
