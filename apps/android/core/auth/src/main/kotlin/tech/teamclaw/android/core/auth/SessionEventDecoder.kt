package tech.teamclaw.android.core.auth

import amux.AcpEvent
import amux.Envelope
import amux.TodoItem as ProtoTodoItem

/**
 * Decoded slice of an [Envelope] that the chat UI cares about. Maps each
 * AcpEvent variant onto a Kotlin sealed surface so the renderer can `when`
 * over it cleanly. Unknown / not-yet-rendered variants collapse to
 * [DecodedEvent.Unknown] with a debug tag — visible in debug, no crash.
 */
sealed interface DecodedEvent {
    val runtimeId: String
    val timestampMs: Long
    val sequence: Long

    data class Thinking(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val text: String,
    ) : DecodedEvent

    data class Output(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val text: String,
        val isComplete: Boolean,
    ) : DecodedEvent

    data class ToolUse(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val toolId: String,
        val toolName: String,
        val description: String,
    ) : DecodedEvent

    data class ToolResult(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val toolId: String,
        val success: Boolean,
        val summary: String,
    ) : DecodedEvent

    data class Error(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val message: String,
    ) : DecodedEvent

    data class PermissionRequest(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        /** From Envelope.device_id — needed to route grant/deny back. */
        val deviceId: String,
        val requestId: String,
        val toolName: String,
        val description: String,
    ) : DecodedEvent

    /**
     * Latest snapshot of the agent's task list. Replaces any prior
     * TodoUpdate from the same runtime — the agent emits a fresh
     * `AcpTodoUpdate` every time it transitions a task, so the renderer
     * shouldn't accumulate them.
     */
    data class TodoUpdate(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val items: List<Item>,
    ) : DecodedEvent {
        data class Item(val content: String, val status: TodoStatus)
    }

    enum class TodoStatus { PENDING, IN_PROGRESS, COMPLETED }

    data class Unknown(
        override val runtimeId: String,
        override val timestampMs: Long,
        override val sequence: Long,
        val variantTag: String,
    ) : DecodedEvent
}

object SessionEventDecoder {
    /** Best-effort decode. Returns null when bytes aren't a valid Envelope. */
    fun decode(bytes: ByteArray): DecodedEvent? {
        if (bytes.isEmpty()) return null
        val envelope = runCatching { Envelope.ADAPTER.decode(bytes) }.getOrNull() ?: return null
        val acp = envelope.acp_event ?: return null
        val ts = envelope.timestamp
        val seq = envelope.sequence.toLong()
        val rid = envelope.runtime_id
        val did = envelope.device_id
        return mapEvent(acp, rid, did, ts, seq)
    }

    private fun mapEvent(
        event: AcpEvent,
        runtimeId: String,
        deviceId: String,
        timestampMs: Long,
        sequence: Long,
    ): DecodedEvent {
        event.thinking?.let {
            return DecodedEvent.Thinking(runtimeId, timestampMs, sequence, it.text)
        }
        event.output?.let {
            return DecodedEvent.Output(runtimeId, timestampMs, sequence, it.text, it.is_complete)
        }
        event.tool_use?.let {
            return DecodedEvent.ToolUse(
                runtimeId, timestampMs, sequence,
                toolId = it.tool_id,
                toolName = it.tool_name,
                description = it.description,
            )
        }
        event.tool_result?.let {
            return DecodedEvent.ToolResult(
                runtimeId, timestampMs, sequence,
                toolId = it.tool_id,
                success = it.success,
                summary = it.summary,
            )
        }
        event.error?.let {
            return DecodedEvent.Error(runtimeId, timestampMs, sequence, it.message)
        }
        event.permission_request?.let {
            return DecodedEvent.PermissionRequest(
                runtimeId, timestampMs, sequence,
                deviceId = deviceId,
                requestId = it.request_id,
                toolName = it.tool_name,
                description = it.description,
            )
        }
        event.todo_update?.let { todo ->
            return DecodedEvent.TodoUpdate(
                runtimeId, timestampMs, sequence,
                items = todo.items.map { item ->
                    DecodedEvent.TodoUpdate.Item(
                        content = item.content,
                        status = mapTodoStatus(item.status),
                    )
                },
            )
        }
        return DecodedEvent.Unknown(
            runtimeId, timestampMs, sequence,
            variantTag = "acp_event",
        )
    }

    private fun mapTodoStatus(status: ProtoTodoItem.Status): DecodedEvent.TodoStatus = when (status) {
        ProtoTodoItem.Status.PENDING -> DecodedEvent.TodoStatus.PENDING
        ProtoTodoItem.Status.IN_PROGRESS -> DecodedEvent.TodoStatus.IN_PROGRESS
        ProtoTodoItem.Status.COMPLETED -> DecodedEvent.TodoStatus.COMPLETED
    }
}
