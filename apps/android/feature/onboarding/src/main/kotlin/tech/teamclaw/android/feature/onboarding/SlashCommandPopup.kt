package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.model.SlashCommand

/**
 * Inline autocomplete popup for ACP slash commands. Rendered by the
 * composer whenever the draft matches `/<prefix>` and at least one
 * known command starts with that prefix. Direct port of iOS
 * SlashCommandsPopup with the same item shape.
 */
@Composable
fun SlashCommandPopup(
    commands: List<SlashCommand>,
    query: String,
    onSelect: (SlashCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    val filtered = remember(commands, query) {
        if (query.isBlank()) commands
        else commands.filter { it.name.startsWith(query, ignoreCase = true) }
    }.take(8)

    if (filtered.isEmpty()) return

    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = 240.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Hai.Paper),
    ) {
        LazyColumn(modifier = Modifier.fillMaxWidth()) {
            items(items = filtered, key = { it.name }) { cmd ->
                SlashRow(cmd, onClick = { onSelect(cmd) })
                if (cmd != filtered.last()) HorizontalDivider(color = Hai.Hairline)
            }
        }
    }
}

@Composable
private fun SlashRow(cmd: SlashCommand, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "/${cmd.name}",
            style = MaterialTheme.typography.bodyMedium.copy(
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
            ),
            color = Hai.Onyx,
        )
        Text(
            text = cmd.description,
            style = MaterialTheme.typography.bodySmall,
            color = Hai.Basalt,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.padding(end = 0.dp))
    }
}
