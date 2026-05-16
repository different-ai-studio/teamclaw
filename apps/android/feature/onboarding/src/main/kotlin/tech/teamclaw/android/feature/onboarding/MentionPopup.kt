package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.model.ActorRecord

/**
 * Floating list of mention candidates for the composer. Filters [actors]
 * by the [query] (case-insensitive substring on displayName) and caps
 * height so it doesn't push the composer off-screen.
 */
@Composable
fun MentionPopup(
    actors: List<ActorRecord>,
    query: String,
    onSelect: (ActorRecord) -> Unit,
    modifier: Modifier = Modifier,
) {
    val filtered = remember(actors, query) {
        if (query.isBlank()) actors
        else actors.filter { it.displayName.contains(query, ignoreCase = true) }
    }.take(6)

    if (filtered.isEmpty()) return

    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = 240.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Hai.Paper),
    ) {
        LazyColumn(modifier = Modifier.fillMaxWidth()) {
            items(items = filtered, key = { it.id }) { actor ->
                MentionRow(actor, onClick = { onSelect(actor) })
                HorizontalDivider(color = Hai.Hairline)
            }
        }
    }
}

@Composable
private fun MentionRow(actor: ActorRecord, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(28.dp).clip(CircleShape)
                .background(if (actor.isAgent) Hai.Sage else Hai.Cinnabar.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                actor.displayName.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                style = MaterialTheme.typography.bodySmall,
                color = if (actor.isAgent) androidx.compose.ui.graphics.Color.White else Hai.Cinnabar,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(actor.displayName, style = MaterialTheme.typography.bodyMedium, color = Hai.Onyx)
            Text(
                if (actor.isAgent) "Agent · ${actor.agentKind ?: "—"}" else actor.roleLabel,
                style = MaterialTheme.typography.bodySmall, color = Hai.Basalt,
            )
        }
    }
}

