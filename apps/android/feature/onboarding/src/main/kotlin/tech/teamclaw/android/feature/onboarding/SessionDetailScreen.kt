package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.auth.DecodedEvent
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.TeamclawTheme
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.MessageRecord
import tech.teamclaw.android.core.model.SlashCommand

@Composable
fun SessionDetailScreen(
    title: String,
    currentActorId: String,
    messages: List<MessageRecord>,
    liveEvents: List<DecodedEvent> = emptyList(),
    mentionCandidates: List<ActorRecord>,
    slashCommands: List<SlashCommand> = emptyList(),
    isLoading: Boolean,
    isSending: Boolean,
    errorMessage: String?,
    onSend: (text: String, mentionActorIds: List<String>) -> Unit,
    onBack: () -> Unit,
    onStartVoiceInput: ((onResult: (String) -> Unit) -> Unit)? = null,
    onPermissionResponse: ((DecodedEvent.PermissionRequest, grant: Boolean) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    var draft by remember { mutableStateOf("") }
    var mentionedActorIds by remember { mutableStateOf(setOf<String>()) }
    val listState = rememberLazyListState()
    val activeMention = remember(draft) { extractActiveMentionQuery(draft) }
    val activeSlash = remember(draft) { extractActiveSlashQuery(draft) }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    Column(
        modifier = modifier.fillMaxSize().background(Hai.Mist).imePadding(),
    ) {
        SessionDetailTopBar(title = title, onBack = onBack)

        if (!errorMessage.isNullOrEmpty()) {
            Box(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                    .clip(RoundedCornerShape(10.dp)).background(Hai.Cinnabar.copy(alpha = 0.10f))
                    .padding(12.dp),
            ) {
                Text(errorMessage, style = MaterialTheme.typography.bodySmall, color = Hai.Onyx)
            }
        }

        if (isLoading && messages.isEmpty()) {
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Hai.Cinnabar)
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f).testTag("sessionDetail.messages"),
                state = listState,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = 16.dp, vertical = 12.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(items = messages, key = { it.id }) { msg ->
                    MessageBubble(message = msg, isMine = msg.senderActorId == currentActorId)
                }
                items(items = liveEvents, key = { "live-${it.sequence}-${it.timestampMs}" }) { evt ->
                    when (evt) {
                        is DecodedEvent.PermissionRequest -> PermissionRequestBubble(
                            event = evt,
                            onGrant = { onPermissionResponse?.invoke(evt, true) },
                            onDeny = { onPermissionResponse?.invoke(evt, false) },
                        )
                        is DecodedEvent.TodoUpdate -> TodoListBubble(evt)
                        else -> LiveEventBubble(evt)
                    }
                }
            }
        }

        if (activeMention != null) {
            MentionPopup(
                actors = mentionCandidates,
                query = activeMention.query,
                onSelect = { actor ->
                    draft = replaceMentionAtCursor(draft, actor.displayName)
                    mentionedActorIds = mentionedActorIds + actor.id
                },
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
        } else if (activeSlash != null && slashCommands.isNotEmpty()) {
            SlashCommandPopup(
                commands = slashCommands,
                query = activeSlash.query,
                onSelect = { cmd ->
                    draft = replaceSlashAtCursor(draft, cmd.name)
                },
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }

        ComposerRow(
            value = draft,
            isSending = isSending,
            onChange = { draft = it },
            onSend = {
                onSend(draft, mentionedActorIds.toList())
                draft = ""
                mentionedActorIds = emptySet()
            },
            onMic = onStartVoiceInput?.let { start ->
                {
                    start { transcript ->
                        draft = (if (draft.isBlank()) transcript else "$draft $transcript").trim()
                    }
                }
            },
        )
    }
}

@Composable
private fun TodoListBubble(event: DecodedEvent.TodoUpdate) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.widthIn(max = 360.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Hai.Paper)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val total = event.items.size
            val done = event.items.count { it.status == DecodedEvent.TodoStatus.COMPLETED }
            Text(
                "Tasks · $done/$total",
                style = MaterialTheme.typography.bodySmall,
                color = Hai.Basalt,
            )
            event.items.forEach { item ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = when (item.status) {
                            DecodedEvent.TodoStatus.PENDING -> "○"
                            DecodedEvent.TodoStatus.IN_PROGRESS -> "◐"
                            DecodedEvent.TodoStatus.COMPLETED -> "●"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = when (item.status) {
                            DecodedEvent.TodoStatus.PENDING -> Hai.Slate
                            DecodedEvent.TodoStatus.IN_PROGRESS -> Hai.Cinnabar
                            DecodedEvent.TodoStatus.COMPLETED -> Hai.Sage
                        },
                    )
                    Text(
                        text = item.content,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (item.status == DecodedEvent.TodoStatus.COMPLETED) Hai.Slate else Hai.Onyx,
                        textDecoration = if (item.status == DecodedEvent.TodoStatus.COMPLETED) {
                            androidx.compose.ui.text.style.TextDecoration.LineThrough
                        } else null,
                    )
                }
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun PermissionRequestBubble(
    event: DecodedEvent.PermissionRequest,
    onGrant: () -> Unit,
    onDeny: () -> Unit,
) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.widthIn(max = 340.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Hai.Cinnabar.copy(alpha = 0.10f))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "Permission requested",
                style = MaterialTheme.typography.labelLarge,
                color = Hai.CinnabarDeep,
            )
            Text(
                "${event.toolName.ifBlank { "tool" }} — ${event.description.ifBlank { "approve to continue" }}",
                style = MaterialTheme.typography.bodyMedium,
                color = Hai.Onyx,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onGrant,
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Hai.Cinnabar),
                    modifier = Modifier.weight(1f).testTag("permission.approveButton"),
                ) { Text("Approve") }
                Button(
                    onClick = onDeny,
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Hai.Basalt),
                    modifier = Modifier.weight(1f).testTag("permission.denyButton"),
                ) { Text("Deny") }
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun LiveEventBubble(event: DecodedEvent) {
    val accent = when (event) {
        is DecodedEvent.Thinking -> Hai.Slate
        is DecodedEvent.Output -> Hai.Basalt
        is DecodedEvent.ToolUse -> Hai.Sage
        is DecodedEvent.ToolResult -> Hai.Sage
        is DecodedEvent.Error -> Hai.CinnabarDeep
        is DecodedEvent.PermissionRequest -> Hai.Cinnabar
        is DecodedEvent.TodoUpdate -> Hai.Basalt
        is DecodedEvent.AvailableCommands -> Hai.Slate
        is DecodedEvent.Unknown -> Hai.Slate
    }
    val (badge, body) = when (event) {
        is DecodedEvent.Thinking -> "Thinking" to event.text
        is DecodedEvent.Output -> {
            val tag = if (event.isComplete) "Output" else "Output…"
            tag to event.text
        }
        is DecodedEvent.ToolUse -> "Tool · ${event.toolName.ifBlank { event.toolId }}" to event.description
        is DecodedEvent.ToolResult -> {
            val tag = if (event.success) "Tool result" else "Tool failed"
            tag to event.summary
        }
        is DecodedEvent.PermissionRequest -> "Permission" to event.description
        is DecodedEvent.TodoUpdate -> "Tasks" to "${event.items.size} item${if (event.items.size == 1) "" else "s"}"
        is DecodedEvent.AvailableCommands -> "Commands" to "${event.commands.size} available"
        is DecodedEvent.Error -> "Error" to event.message
        is DecodedEvent.Unknown -> "Event" to event.variantTag
    }
    Row(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.widthIn(max = 340.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Hai.Paper)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                badge,
                style = MaterialTheme.typography.bodySmall,
                color = accent,
            )
            if (body.isNotBlank()) {
                Text(
                    body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Hai.Basalt,
                )
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

private data class ActiveMention(val start: Int, val query: String)

private val mentionPattern = Regex("@(\\w*)$")

private fun extractActiveMentionQuery(text: String): ActiveMention? {
    val match = mentionPattern.find(text) ?: return null
    return ActiveMention(start = match.range.first, query = match.groupValues[1])
}

private fun replaceMentionAtCursor(text: String, displayName: String): String {
    val match = mentionPattern.find(text) ?: return text
    val before = text.substring(0, match.range.first)
    return "$before@$displayName "
}

private data class ActiveSlash(val start: Int, val query: String)

// Match `/<word>` only when it's the start of the line or message — same
// rule iOS uses to avoid picking up file paths like /tmp/foo mid-sentence.
private val slashPattern = Regex("(^|\\s)/([A-Za-z0-9_\\-]*)$")

private fun extractActiveSlashQuery(text: String): ActiveSlash? {
    val match = slashPattern.find(text) ?: return null
    return ActiveSlash(start = match.range.first, query = match.groupValues[2])
}

private fun replaceSlashAtCursor(text: String, commandName: String): String {
    val match = slashPattern.find(text) ?: return text
    val leadingWs = match.groupValues[1]
    val before = text.substring(0, match.range.first)
    return "$before$leadingWs/$commandName "
}

@Composable
private fun SessionDetailTopBar(title: String, onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack, modifier = Modifier.testTag("sessionDetail.backButton")) {
            Text("Back", color = Hai.Cinnabar)
        }
        Text(
            text = title.ifBlank { "Session" },
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleLarge,
            color = Hai.Onyx,
        )
        Spacer(Modifier.size(72.dp))
    }
}

@Composable
private fun MessageBubble(message: MessageRecord, isMine: Boolean) {
    val textColor = if (isMine) androidx.compose.ui.graphics.Color.White else Hai.Onyx
    Row(modifier = Modifier.fillMaxWidth()) {
        if (isMine) Spacer(Modifier.weight(1f))
        Column(
            modifier = Modifier.widthIn(max = 320.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(if (isMine) Hai.Cinnabar else Hai.Paper)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            MarkdownText(raw = message.content, contentColor = textColor)
        }
        if (!isMine) Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun ComposerRow(
    value: String,
    isSending: Boolean,
    onChange: (String) -> Unit,
    onSend: () -> Unit,
    onMic: (() -> Unit)?,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.weight(1f).testTag("sessionDetail.composerField"),
            placeholder = { Text("Message…") },
            shape = RoundedCornerShape(20.dp),
            maxLines = 4,
        )
        if (onMic != null) {
            TextButton(
                onClick = onMic,
                modifier = Modifier.testTag("sessionDetail.micButton"),
            ) {
                Text("🎙", style = MaterialTheme.typography.titleLarge, color = Hai.Basalt)
            }
        }
        Button(
            onClick = onSend,
            enabled = !isSending && value.isNotBlank(),
            shape = RoundedCornerShape(20.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Hai.Cinnabar),
            modifier = Modifier.testTag("sessionDetail.sendButton"),
        ) {
            Text(if (isSending) "…" else "Send")
        }
    }
}

@Preview
@Composable
private fun SessionDetailPreview() {
    TeamclawTheme {
        SessionDetailScreen(
            title = "Plan migration",
            currentActorId = "me",
            messages = listOf(
                MessageRecord("1", "s", "me", "text", "Hey", 0L, null, null),
                MessageRecord("2", "s", "agent-1", "text", "Hi! How can I help?", 0L, null, null),
            ),
            mentionCandidates = emptyList(),
            isLoading = false, isSending = false, errorMessage = null,
            onSend = { _, _ -> }, onBack = {},
        )
    }
}
