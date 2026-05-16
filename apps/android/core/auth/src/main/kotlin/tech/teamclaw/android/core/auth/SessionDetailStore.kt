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
import tech.teamclaw.android.core.model.SlashCommand

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
    /** Optional decoded-event stream — typically [MqttService.subscribeAsEvents]. */
    private val realtimeEvents: Flow<DecodedEvent>? = null,
    /** Publish a permission grant/deny back to the daemon. Null in tests. */
    private val permissionPublisher: (suspend (
        deviceId: String,
        runtimeId: String,
        requestId: String,
        grant: Boolean,
    ) -> Unit)? = null,
) {
    data class UiState(
        val messages: List<MessageRecord> = emptyList(),
        /** Live events the agent is emitting right now (thinking/tool/output deltas).
         *  Cleared on reload — these are transient until they roll up into a
         *  finalized message in PostgREST. */
        val liveEvents: List<DecodedEvent> = emptyList(),
        /** Slash-command palette the agent has advertised via AcpAvailableCommands.
         *  Persists across reloads since the palette is a property of the agent,
         *  not of any one turn. */
        val availableCommands: List<SlashCommand> = emptyList(),
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
        val job = scope.launch {
            signal.collect { reload() }
        }
        // Live decoded-events stream runs in a sibling coroutine. Each event
        // appends to liveEvents until a reload() clears them (which happens
        // on every signal — and the agent's final reply gets persisted by
        // the daemon so the PostgREST refresh is the source of truth).
        realtimeEvents?.let { events ->
            scope.launch {
                events.collect { event ->
                    when (event) {
                        is DecodedEvent.AvailableCommands ->
                            _state.update { it.copy(availableCommands = event.commands) }
                        else ->
                            _state.update { it.copy(liveEvents = mergeEvent(it.liveEvents, event)) }
                    }
                }
            }
        }
        return job
    }

    /**
     * Append [event] to [existing], collapsing consecutive [DecodedEvent.Output]
     * frames from the same runtime into a single rolling text buffer (the
     * stream of deltas the agent emits as it types). All other event kinds
     * are appended as discrete bubbles.
     */
    private fun mergeEvent(existing: List<DecodedEvent>, event: DecodedEvent): List<DecodedEvent> {
        // TodoUpdate: replace any prior TodoUpdate from the same runtime —
        // the agent emits a fresh full list on each transition, so we keep
        // exactly one in the live-events stream per runtime.
        if (event is DecodedEvent.TodoUpdate) {
            return existing.filterNot {
                it is DecodedEvent.TodoUpdate && it.runtimeId == event.runtimeId
            } + event
        }
        if (event !is DecodedEvent.Output) return existing + event
        val last = existing.lastOrNull()
        if (last is DecodedEvent.Output && last.runtimeId == event.runtimeId && !last.isComplete) {
            return existing.dropLast(1) + last.copy(
                text = last.text + event.text,
                isComplete = event.isComplete,
                sequence = event.sequence,
                timestampMs = event.timestampMs,
            )
        }
        return existing + event
    }

    suspend fun reload() {
        if (_state.value.isLoading) return
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        try {
            val rows = repository.listMessages(sessionId)
            _state.update {
                // Clear liveEvents on reload — the events that fired before
                // this reload are now either persisted in `messages` (final
                // output) or no longer relevant (intermediate thinking).
                it.copy(messages = rows, liveEvents = emptyList(), isLoading = false)
            }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message, isLoading = false) }
        }
    }

    suspend fun respondToPermission(request: DecodedEvent.PermissionRequest, grant: Boolean) {
        val publisher = permissionPublisher ?: return
        runCatching {
            publisher(request.deviceId, request.runtimeId, request.requestId, grant)
        }
        // Drop the request from liveEvents either way — user has answered.
        _state.update {
            it.copy(
                liveEvents = it.liveEvents.filterNot {
                    e -> e is DecodedEvent.PermissionRequest && e.requestId == request.requestId
                },
            )
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
