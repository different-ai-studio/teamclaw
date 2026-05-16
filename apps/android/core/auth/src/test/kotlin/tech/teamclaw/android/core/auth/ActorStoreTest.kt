package tech.teamclaw.android.core.auth

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.InviteCreateInput
import tech.teamclaw.android.core.model.InviteCreated
import tech.teamclaw.android.core.model.InviteKind
import tech.teamclaw.android.core.model.TeamRole

@OptIn(ExperimentalCoroutinesApi::class)
class ActorStoreTest {

    private class FakeActorRepo(
        var actors: List<ActorRecord> = emptyList(),
        var invite: InviteCreated? = null,
        var listError: Throwable? = null,
        var inviteError: Throwable? = null,
    ) : ActorRepository {
        override suspend fun listActors(teamId: String): List<ActorRecord> {
            listError?.let { throw it }
            return actors
        }
        override suspend fun createInvite(teamId: String, input: InviteCreateInput): InviteCreated {
            inviteError?.let { throw it }
            return invite ?: error("set invite")
        }
        override suspend fun removeActor(actorId: String) {
            actors = actors.filterNot { it.id == actorId }
        }
    }

    private fun sample(id: String, displayName: String) = ActorRecord(
        id, "T", "member", "u$id", null, displayName,
        null, 0L, 0L, "active", "member", null, null,
    )

    @Test fun `reload populates actors`() = runTest {
        val repo = FakeActorRepo(actors = listOf(sample("1", "Alice")))
        val store = ActorStore("T", repo)
        store.reload()
        assertThat(store.state.value.actors).hasSize(1)
        assertThat(store.state.value.errorMessage).isNull()
    }

    @Test fun `createInvite stores last invite`() = runTest {
        val repo = FakeActorRepo(invite = InviteCreated("XYZ", 0L, "teamclaw://invite?token=XYZ"))
        val store = ActorStore("T", repo)
        store.createInvite(InviteCreateInput(InviteKind.MEMBER, "Bob", TeamRole.MEMBER))
        assertThat(store.state.value.lastInvite?.token).isEqualTo("XYZ")
        assertThat(store.state.value.errorMessage).isNull()
    }

    @Test fun `createInvite surfaces error`() = runTest {
        val repo = FakeActorRepo(inviteError = RuntimeException("rate-limited"))
        val store = ActorStore("T", repo)
        store.createInvite(InviteCreateInput(InviteKind.MEMBER, "Bob", TeamRole.MEMBER))
        assertThat(store.state.value.errorMessage).contains("rate-limited")
        assertThat(store.state.value.lastInvite).isNull()
    }

    @Test fun `clearLastInvite resets`() = runTest {
        val repo = FakeActorRepo(invite = InviteCreated("XYZ", 0L, "teamclaw://invite?token=XYZ"))
        val store = ActorStore("T", repo)
        store.createInvite(InviteCreateInput(InviteKind.MEMBER, "Bob", TeamRole.MEMBER))
        store.clearLastInvite()
        assertThat(store.state.value.lastInvite).isNull()
    }
}
