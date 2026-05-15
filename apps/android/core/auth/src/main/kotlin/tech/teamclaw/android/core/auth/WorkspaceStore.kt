package tech.teamclaw.android.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import tech.teamclaw.android.core.model.WorkspaceRecord

/**
 * Per-team workspace cache. Port of iOS WorkspaceStore. Single source of
 * truth: hold the list in StateFlow, expose loading + error state, refresh
 * idempotently.
 */
class WorkspaceStore(
    private val teamId: String,
    private val repository: WorkspaceRepository,
) {
    data class UiState(
        val workspaces: List<WorkspaceRecord> = emptyList(),
        val isLoading: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    suspend fun reload(agentId: String? = null) {
        if (_state.value.isLoading) return
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        try {
            val rows = repository.listWorkspaces(teamId, agentId)
            _state.update { it.copy(workspaces = rows, isLoading = false) }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message, isLoading = false) }
        }
    }
}
