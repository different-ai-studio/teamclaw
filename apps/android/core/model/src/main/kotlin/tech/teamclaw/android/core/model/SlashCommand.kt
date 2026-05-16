package tech.teamclaw.android.core.model

/**
 * Agent-declared slash command. Snapshot replaced each time the agent
 * emits an AcpAvailableCommands event. Equivalent shape to iOS
 * SlashCommand struct used by SlashCommandsPopup.
 */
data class SlashCommand(
    val name: String,
    val description: String,
    val inputHint: String,
)
