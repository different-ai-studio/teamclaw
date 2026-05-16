package tech.teamclaw.android.core.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.teamclaw.android.core.model.MessageRecord

/**
 * Per-session message timeline. PostgREST-seeded; optionally re-fetches on
 * each MQTT signal so agent replies appear without a manual refresh.
 */
class SessionDetailStore(
    private val teamId: String,
    private val sessionId: String,
    private val currentActorId: String,
    private val repository: MessagesRepository,
    /** Optional realtime signal — typically [MqttService.subscribeAsSignal]. */
    private val realtimeSignal: Flow<Unit>? = null,
) {
    data class UiState(
        val messages: List<MessageRecord> = emptyList(),
        val isLoading: Boolean = false,
        val isSending: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /**
     * Start collecting realtime signals. The caller scopes the collection to
     * the screen lifecycle — when [scope] is cancelled, the subscription
     * dies. Idempotent; calling twice from the same scope returns the
     * same job.
     */
    fun startRealtime(scope: CoroutineScope): Job? {
        val signal = realtimeSignal ?: return null
        return scope.launch {
            signal.collect { reload() }
        }
    }

    suspend fun reload() {
        if (_state.value.isLoading) return
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        try {
            val rows = repository.listMessages(sessionId)
            _state.update { it.copy(messages = rows, isLoading = false) }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message, isLoading = false) }
        }
    }

    suspend fun send(content: String, mentionActorIds: List<String> = emptyList()) {
        val trimmed = content.trim()
        if (trimmed.isEmpty()) return
        if (_state.value.isSending) return
        _state.update { it.copy(isSending = true, errorMessage = null) }
        try {
            val inserted = repository.insertUserMessage(
                teamId = teamId,
                sessionId = sessionId,
                senderActorId = currentActorId,
                content = trimmed,
                mentionActorIds = mentionActorIds,
            )
            _state.update { it.copy(messages = it.messages + inserted, isSending = false) }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message, isSending = false) }
        }
    }
}
