use super::read_config;

/// Supported locales
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    ZhCN,
}

impl Locale {
    pub fn from_str(s: &str) -> Locale {
        match s {
            "zh-CN" | "zh" | "zh-cn" => Locale::ZhCN,
            _ => Locale::En,
        }
    }
}

/// Read locale from teamclaw.json config, defaulting to En
pub fn get_locale(workspace_path: &str) -> Locale {
    read_config(workspace_path)
        .ok()
        .and_then(|c| c.locale)
        .map(|s| Locale::from_str(&s))
        .unwrap_or(Locale::En)
}

/// All translatable message keys
pub enum MsgKey<'a> {
    // === Shared: /model command ===
    CurrentModelCustom(&'a str),
    CurrentModelDefault(&'a str),
    AvailableModels,
    ModelSwitchUsage,
    ModelSwitched(&'a str),
    ModelResetToDefault,
    ModelNotFound(&'a str),
    FailedToGetModels(&'a str),
    ModelListTruncated,
    ModelCurrentMarker,

    // === Shared: /sessions command ===
    NoSessionsFound,
    RecentSessions,
    Untitled,
    CurrentSessionMarker,
    SessionsSwitchUsage,
    InvalidSessionNumber(&'a str),
    SessionNotFound(usize, usize),
    SwitchedToSession(&'a str),
    SwitchedToSessionWithLatest(&'a str, &'a str),
    SwitchedToSessionNoLatest(&'a str),
    FailedToListSessions(&'a str),
    NoAssistantMessages,

    // === Shared: /stop command ===
    NoActiveSession,
    SessionStopped,
    FailedToStopSession(&'a str),
    FailedToStopSessionWithStatus(u16, &'a str),

    // === Shared: time formatting ===
    JustNow,
    MinAgo(i64),
    HrAgo(i64),
    DayAgo(i64),

    // === Shared: session reset ===
    SessionReset,

    // === Shared: /answer responses ===
    AnswerSubmitted(&'a str),
    NoPendingQuestions,

    // === Shared: pending question prompt ===
    PendingQuestionUsage,
    PendingQuestionExample(&'a str),

    // === Queue messages (WeChat, WeCom) ===
    QueueTimeout,
    QueueFull,
    GatewayShuttingDown,
    MessageCouldNotBeProcessed,

    // === Error fallback ===
    ModelEmptyResponse,

    // === Unknown command ===
    UnknownCommand(&'a str),

    // === /help per-gateway ===
    HelpWechat,
    HelpWecom,
    HelpDiscord,
    HelpKook,

    // === WeCom welcome ===
    WecomWelcome,

    // === Discord specific ===
    LoadingSessions,

    // === KOOK card-specific ===
    KookCardHeaderModels,
    KookCardCurrentModel(&'a str, bool),
    KookCardHeaderHelp,
    KookCardHelpUsage,
}

/// Return the translated string for a given key and locale
pub fn t(key: MsgKey, locale: Locale) -> String {
    use Locale::*;
    use MsgKey::*;
    match (key, locale) {
        // === /model command ===
        (CurrentModelCustom(m), En) => format!("**Current Model:** `{}` (custom)\n\n", m),
        (CurrentModelCustom(m), ZhCN) => format!("**当前模型:** `{}` (自定义)\n\n", m),

        (CurrentModelDefault(m), En) => format!("**Current Model:** `{}` (default)\n\n", m),
        (CurrentModelDefault(m), ZhCN) => format!("**当前模型:** `{}` (默认)\n\n", m),

        (AvailableModels, En) => "**Available Models:**\n".into(),
        (AvailableModels, ZhCN) => "**可用模型:**\n".into(),

        (ModelSwitchUsage, En) => "\n\nUse `/model <provider/model>` to switch.\nUse `/model default` to reset to default.".into(),
        (ModelSwitchUsage, ZhCN) => "\n\n使用 `/model <provider/model>` 切换模型。\n使用 `/model default` 恢复默认。".into(),

        (ModelSwitched(m), En) => format!("Model switched to: `{}`\nAll subsequent messages in this context will use this model.", m),
        (ModelSwitched(m), ZhCN) => format!("模型已切换为: `{}`\n后续消息将使用此模型。", m),

        (ModelResetToDefault, En) => "Model reset to default. Subsequent messages will use the global default model.".into(),
        (ModelResetToDefault, ZhCN) => "已恢复默认模型，后续消息将使用全局默认模型。".into(),

        (ModelNotFound(m), En) => format!("Model `{}` not found. Use `/model` to see available models.", m),
        (ModelNotFound(m), ZhCN) => format!("模型 `{}` 未找到。使用 `/model` 查看可用模型。", m),

        (FailedToGetModels(e), En) => format!("Failed to get models: {}", e),
        (FailedToGetModels(e), ZhCN) => format!("获取模型列表失败: {}", e),

        (ModelListTruncated, En) => "\n_(List truncated due to length. Visit OpenCode UI for full model list.)_".into(),
        (ModelListTruncated, ZhCN) => "\n_(列表过长已截断，请在 OpenCode 界面查看完整列表。)_".into(),

        (ModelCurrentMarker, En) => " ← current".into(),
        (ModelCurrentMarker, ZhCN) => " ← 当前".into(),

        // === /sessions command ===
        (NoSessionsFound, En) => "No sessions found.".into(),
        (NoSessionsFound, ZhCN) => "暂无会话。".into(),

        (RecentSessions, En) => "**Recent Sessions:**\n".into(),
        (RecentSessions, ZhCN) => "**最近会话:**\n".into(),

        (Untitled, En) => "(untitled)".into(),
        (Untitled, ZhCN) => "(无标题)".into(),

        (CurrentSessionMarker, En) => "  <-- current".into(),
        (CurrentSessionMarker, ZhCN) => "  <-- 当前".into(),

        (SessionsSwitchUsage, En) => "\nUse `/sessions <number>` to switch.".into(),
        (SessionsSwitchUsage, ZhCN) => "\n使用 `/sessions <编号>` 切换会话。".into(),

        (InvalidSessionNumber(s), En) => format!("`{}` is not a valid session number. Use `/sessions` to see the list.", s),
        (InvalidSessionNumber(s), ZhCN) => format!("`{}` 不是有效的会话编号。使用 `/sessions` 查看列表。", s),

        (SessionNotFound(num, total), En) => format!("Session #{} not found. There are only {} sessions.", num, total),
        (SessionNotFound(num, total), ZhCN) => format!("会话 #{} 不存在，当前共有 {} 个会话。", num, total),

        (SwitchedToSession(title), En) => format!("Switched to session: \"{}\"", title),
        (SwitchedToSession(title), ZhCN) => format!("已切换到会话: \"{}\"", title),

        (SwitchedToSessionWithLatest(title, latest), En) => {
            format!("Switched to session: \"{}\"\n\n**Latest response:**\n{}", title, latest)
        }
        (SwitchedToSessionWithLatest(title, latest), ZhCN) => {
            format!("已切换到会话: \"{}\"\n\n**最近回复:**\n{}", title, latest)
        }

        (SwitchedToSessionNoLatest(title), En) => {
            format!("Switched to session: \"{}\"\n\nSubsequent messages will be sent to this session.", title)
        }
        (SwitchedToSessionNoLatest(title), ZhCN) => {
            format!("已切换到会话: \"{}\"\n\n后续消息将发送到此会话。", title)
        }

        (FailedToListSessions(e), En) => format!("Failed to list sessions: {}", e),
        (FailedToListSessions(e), ZhCN) => format!("获取会话列表失败: {}", e),

        (NoAssistantMessages, En) => "(no assistant messages yet)".into(),
        (NoAssistantMessages, ZhCN) => "(暂无助手消息)".into(),

        // === /stop command ===
        (NoActiveSession, En) => "No active session. Nothing to stop.".into(),
        (NoActiveSession, ZhCN) => "没有活跃会话，无需停止。".into(),

        (SessionStopped, En) => "Session processing stopped.".into(),
        (SessionStopped, ZhCN) => "会话处理已停止。".into(),

        (FailedToStopSession(e), En) => format!("Failed to stop session: {}", e),
        (FailedToStopSession(e), ZhCN) => format!("停止会话失败: {}", e),

        (FailedToStopSessionWithStatus(status, body), En) => format!("Failed to stop session ({}): {}", status, body),
        (FailedToStopSessionWithStatus(status, body), ZhCN) => format!("停止会话失败 ({}): {}", status, body),

        // === Time formatting ===
        (JustNow, En) => "just now".into(),
        (JustNow, ZhCN) => "刚刚".into(),

        (MinAgo(n), En) => format!("{} min ago", n),
        (MinAgo(n), ZhCN) => format!("{} 分钟前", n),

        (HrAgo(n), En) => format!("{} hr ago", n),
        (HrAgo(n), ZhCN) => format!("{} 小时前", n),

        (DayAgo(n), En) => format!("{} day ago", n),
        (DayAgo(n), ZhCN) => format!("{} 天前", n),

        // === Session reset ===
        (SessionReset, En) => "Session reset. Next message will start a new conversation.".into(),
        (SessionReset, ZhCN) => "会话已重置，下一条消息将开始新对话。".into(),

        // === /answer responses ===
        (AnswerSubmitted(text), En) => format!("✓ Answered: {}", text),
        (AnswerSubmitted(text), ZhCN) => format!("✓ 已回复: {}", text),

        (NoPendingQuestions, En) => "No pending questions to answer.".into(),
        (NoPendingQuestions, ZhCN) => "当前没有待回复的问题。".into(),

        // === Pending question prompt ===
        (PendingQuestionUsage, En) => "Reply with /answer <number or text>, valid for 5 minutes\n".into(),
        (PendingQuestionUsage, ZhCN) => "请用 /answer <序号或内容> 回复，5分钟内有效\n".into(),

        (PendingQuestionExample(qid), En) => format!("e.g.: /answer 1\n[Q:{}]", qid),
        (PendingQuestionExample(qid), ZhCN) => format!("例如: /answer 1\n[Q:{}]", qid),

        // === Queue messages ===
        (QueueTimeout, En) => "Message queue timeout, please try again.".into(),
        (QueueTimeout, ZhCN) => "消息排队超时，请重试。".into(),

        (QueueFull, En) => "Too many messages, please wait.".into(),
        (QueueFull, ZhCN) => "消息过多，请稍候。".into(),

        (GatewayShuttingDown, En) => "Gateway is shutting down.".into(),
        (GatewayShuttingDown, ZhCN) => "网关正在关闭。".into(),

        (MessageCouldNotBeProcessed, En) => "Your message could not be processed. Please resend.".into(),
        (MessageCouldNotBeProcessed, ZhCN) => "消息处理失败，请重新发送。".into(),

        // === Error fallback ===
        (ModelEmptyResponse, En) => "The model returned no text content. Please try again or rephrase.".into(),
        (ModelEmptyResponse, ZhCN) => "模型未返回文字内容，请稍后重试或换种说法。".into(),

        // === Unknown command ===
        (UnknownCommand(cmd), En) => format!("Unknown command: {}\nType /help for available commands.", cmd),
        (UnknownCommand(cmd), ZhCN) => format!("未知命令: {}\n输入 /help 查看可用命令。", cmd),

        // === /help per-gateway ===
        (HelpWechat, En) => "Available commands:\n\
            /help - Show this help\n\
            /model [name] - List or switch models\n\
            /sessions [id] - List or bind sessions\n\
            /reset - Start new session\n\
            /stop - Stop current processing\n\
            /answer - Reply to an AI clarification (see bot message)".into(),
        (HelpWechat, ZhCN) => "可用命令:\n\
            /help - 显示帮助\n\
            /model [名称] - 查看或切换模型\n\
            /sessions [编号] - 查看或绑定会话\n\
            /reset - 开始新会话\n\
            /stop - 停止当前处理\n\
            /answer - 回复 AI 的澄清问题（见机器人消息）".into(),

        (HelpWecom, En) => "Available commands:\n\
            /help - Show this help\n\
            /model [name] - List or switch models\n\
            /sessions [id] - List or bind sessions\n\
            /reset - Start new session\n\
            /stop - Stop current processing".into(),
        (HelpWecom, ZhCN) => "可用命令:\n\
            /help - 显示帮助\n\
            /model [名称] - 查看或切换模型\n\
            /sessions [编号] - 查看或绑定会话\n\
            /reset - 开始新会话\n\
            /stop - 停止当前处理".into(),

        (HelpDiscord, En) => "**TeamClaw Bot Commands**\n\n\
            /reset - Reset the current chat session\n\
            /model - View current model or switch models\n\
            /sessions - List or switch sessions\n\
            /stop - Stop the current processing\n\
            /help - Show this help message\n\n\
            **How to use:**\n\
            • In DMs: Just send a message to start chatting\n\
            • In channels: Mention the bot or reply to its messages\n\n\
            You can also send images along with your messages!".into(),
        (HelpDiscord, ZhCN) => "**TeamClaw 机器人命令**\n\n\
            /reset - 重置当前聊天会话\n\
            /model - 查看或切换模型\n\
            /sessions - 查看或切换会话\n\
            /stop - 停止当前处理\n\
            /help - 显示帮助\n\n\
            **使用方法:**\n\
            • 私聊: 直接发消息开始对话\n\
            • 频道: @机器人 或回复机器人消息\n\n\
            你也可以在消息中附带图片！".into(),

        (HelpKook, En) => "/reset - Reset the current chat session\n\
            /model - View current model or switch models\n\
            /sessions - List or switch sessions\n\
            /stop - Stop the current processing\n\
            /help - Show this help message".into(),
        (HelpKook, ZhCN) => "/reset - 重置当前聊天会话\n\
            /model - 查看或切换模型\n\
            /sessions - 查看或切换会话\n\
            /stop - 停止当前处理\n\
            /help - 显示帮助".into(),

        // === WeCom welcome ===
        (WecomWelcome, En) => "Hello! I'm an AI assistant. Send me a message to start a conversation, or type /help for available commands.".into(),
        (WecomWelcome, ZhCN) => "你好！我是 AI 助手。直接发消息给我开始对话，发送 /help 查看可用命令。".into(),

        // === Discord specific ===
        (LoadingSessions, En) => "Loading sessions...".into(),
        (LoadingSessions, ZhCN) => "正在加载会话...".into(),

        // === KOOK card-specific ===
        (KookCardHeaderModels, En) => "Available Models".into(),
        (KookCardHeaderModels, ZhCN) => "可用模型".into(),

        (KookCardCurrentModel(model, true), En) => format!("**Current Model:** {} (custom)", model),
        (KookCardCurrentModel(model, true), ZhCN) => format!("**当前模型:** {} (自定义)", model),
        (KookCardCurrentModel(model, false), En) => format!("**Current Model:** {} (default)", model),
        (KookCardCurrentModel(model, false), ZhCN) => format!("**当前模型:** {} (默认)", model),

        (KookCardHeaderHelp, En) => "TeamClaw Bot Commands".into(),
        (KookCardHeaderHelp, ZhCN) => "TeamClaw 机器人命令".into(),

        (KookCardHelpUsage, En) => "In DMs: Just send a message to start chatting. In channels: Send messages directly.".into(),
        (KookCardHelpUsage, ZhCN) => "私聊: 直接发消息开始对话。频道: 直接发送消息即可。".into(),
    }
}
