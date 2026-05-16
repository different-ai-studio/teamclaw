package tech.teamclaw.android.core.auth

import amux.AcpEvent
import amux.Envelope

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
        return mapEvent(acp, rid, ts, seq)
    }

    private fun mapEvent(
        event: AcpEvent,
        runtimeId: String,
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
        return DecodedEvent.Unknown(
            runtimeId, timestampMs, sequence,
            variantTag = "acp_event",
        )
    }
}
