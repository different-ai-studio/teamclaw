package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.TeamclawTheme
import tech.teamclaw.android.core.model.SessionRecord

@Composable
fun SessionListScreen(
    teamName: String,
    sessions: List<SessionRecord>,
    isLoading: Boolean,
    errorMessage: String?,
    onRefresh: () -> Unit,
    onSessionClick: (SessionRecord) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize().background(Hai.Mist),
    ) {
        SessionListTopBar(teamName = teamName, onSignOut = onSignOut, onRefresh = onRefresh)

        if (!errorMessage.isNullOrEmpty()) {
            Box(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                    .clip(RoundedCornerShape(10.dp)).background(Hai.Cinnabar.copy(alpha = 0.10f))
                    .padding(12.dp),
            ) {
                Text(errorMessage, style = MaterialTheme.typography.bodySmall, color = Hai.Onyx)
            }
        }

        if (isLoading && sessions.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Hai.Cinnabar)
            }
        } else if (sessions.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    "No sessions yet.",
                    style = MaterialTheme.typography.bodyLarge, color = Hai.Basalt,
                )
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().testTag("sessionList.list")) {
                items(items = sessions, key = { it.id }) { session ->
                    SessionRow(session = session, onClick = { onSessionClick(session) })
                    HorizontalDivider(color = Hai.Hairline)
                }
            }
        }
    }
}

@Composable
private fun SessionListTopBar(
    teamName: String,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("Sessions", style = MaterialTheme.typography.headlineMedium, color = Hai.Onyx)
            Text(teamName, style = MaterialTheme.typography.bodySmall, color = Hai.Basalt)
        }
        TextButton(onClick = onRefresh) { Text("Refresh", color = Hai.Cinnabar) }
        TextButton(onClick = onSignOut, modifier = Modifier.testTag("sessionList.signOutButton")) {
            Text("Sign out", color = Hai.Basalt)
        }
    }
}

@Composable
private fun SessionRow(session: SessionRecord, onClick: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = session.title.ifBlank { "Untitled session" },
            style = MaterialTheme.typography.labelLarge,
            color = Hai.Onyx,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (session.lastMessagePreview.isNotBlank()) {
            Text(
                text = session.lastMessagePreview,
                style = MaterialTheme.typography.bodySmall,
                color = Hai.Basalt,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "${session.participantCount} participant${if (session.participantCount == 1) "" else "s"}",
                style = MaterialTheme.typography.bodySmall, color = Hai.Slate,
            )
            Spacer(Modifier.weight(1f))
        }
    }
}

@Preview
@Composable
private fun SessionListPreview() {
    TeamclawTheme {
        SessionListScreen(
            teamName = "Quiet Harbor",
            sessions = listOf(
                SessionRecord(
                    id = "1", teamId = "t", ideaId = null, createdByActorId = "a",
                    primaryAgentId = "ag", mode = "chat",
                    title = "Plan migration", summary = "",
                    participantCount = 3, lastMessagePreview = "Yeah let's start with the schema review",
                    lastMessageAtMs = 0L, createdAtMs = 0L,
                ),
                SessionRecord(
                    id = "2", teamId = "t", ideaId = null, createdByActorId = "a",
                    primaryAgentId = null, mode = "chat",
                    title = "", summary = "", participantCount = 1, lastMessagePreview = "",
                    lastMessageAtMs = null, createdAtMs = 0L,
                ),
            ),
            isLoading = false, errorMessage = null,
            onRefresh = {}, onSessionClick = {}, onSignOut = {},
        )
    }
}
