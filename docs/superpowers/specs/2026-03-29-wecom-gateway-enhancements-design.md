# WeCom Gateway Enhancements

## Goal

Bring the WeCom gateway into full alignment with the long-connection API specification, fix protocol issues, add missing message/event types, and upgrade the question interaction UX with template cards.

## Scope

Six changes grouped into three areas:

- **A. Protocol fixes** — `chat_type`, markdown push, JSON ping
- **B. File message** — receive and forward to OpenCode
- **C. Events & cards** — welcome message, template card questions

### Out of scope

- AES-256-CBC media decryption (images work without it; add when needed)
- `mixed` (图文混排) message type (add when encountered)
- Video message receiving (AI cannot process video)
- Non-text proactive push types beyond markdown (file/image/voice/video via `media_id`)
- Upload temporary media (`aibot_upload_media_init/chunk/finish`)

---

## A. Protocol Fixes

### A1. Add `chat_type` to `aibot_send_msg`

**Problem:** Our `send_chat_message()` does not send `chat_type`. Per docs, omitting it defaults to group-first resolution, which may fail for single-chat targets.

**Change in `wecom.rs` — `send_chat_message()`:**

Add a `chat_type` parameter. The JSON body becomes:

```json
{
  "cmd": "aibot_send_msg",
  "headers": { "req_id": "<uuid>" },
  "body": {
    "chatid": "<chatid>",
    "chat_type": 1,
    "msgtype": "markdown",
    "markdown": { "content": "<text>" }
  }
}
```

`chat_type` values: `1` = single chat (userid), `2` = group chat (chatid).

**Change in `send_proactive_message()`:**

Accept a `chat_type: u32` parameter. Callers provide the correct value.

**Change in `cron/delivery.rs` — `send_wecom()` target format:**

Update the target format to include chat type. Two formats supported:
- `single:{userid}` — single chat, `chat_type = 1`
- `group:{chatid}` — group chat, `chat_type = 2`
- Raw value without prefix — default to `chat_type = 1` (single chat, safest default for cron delivery to a person)

**Change in `cron-utils.ts` — WeCom registry entry:**

Add modes (like Discord/KOOK):
```typescript
modes: [
  { value: 'single', label: 'Single Chat (DM)' },
  { value: 'group', label: 'Group Chat' },
],
fields: {
  single: [{ key: 'userId', label: 'User ID', ... }],
  group: [{ key: 'chatId', label: 'Chat ID', ... }],
},
buildTarget: (mode, values) =>
  mode === 'group' ? `group:${values.chatId}` : `single:${values.userId}`,
```

**Change in `cron/scheduler.rs` — session key:**

Update to parse the new prefix:
- `single:{userid}` → `wecom:dm:{userid}`
- `group:{chatid}` → `wecom:{chatid}`
- Raw value → `wecom:dm:{value}`

### A2. Markdown for proactive push

**Problem:** `aibot_send_msg` currently sends `msgtype: "text"`. Cron results and other push content is often formatted text that benefits from markdown rendering.

**Change:** In `send_chat_message()`, switch from:
```json
{ "msgtype": "text", "text": { "content": "..." } }
```
to:
```json
{ "msgtype": "markdown", "markdown": { "content": "..." } }
```

Streaming replies (`aibot_respond_msg`) remain `msgtype: "stream"` — no change there.

### A3. JSON ping heartbeat

**Problem:** We send WebSocket native PING frames. The WeCom docs specify a JSON-level ping command.

**Change in `connect_and_run()` heartbeat task:**

Replace:
```rust
let ping = tokio_tungstenite::tungstenite::Message::Ping(vec![].into());
```
with:
```rust
let ping_json = serde_json::json!({
    "cmd": "ping",
    "headers": { "req_id": uuid::Uuid::new_v4().to_string() }
});
let ping = tokio_tungstenite::tungstenite::Message::Text(ping_json.to_string().into());
```

Keep the 30-second interval unchanged.

---

## B. File Message Receiving

### B1. Handle `msgtype: "file"`

**Problem:** File messages are currently ignored ("Unsupported message type").

**Change in `handle_message_callback()`:**

Add a `"file"` match arm alongside `"image"`:

```rust
"file" => {
    let file_url = msg.file
        .as_ref()
        .and_then(|f| f.get("url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let file_name = msg.file
        .as_ref()
        .and_then(|f| f.get("filename"))
        .and_then(|v| v.as_str())
        .unwrap_or("unnamed_file")
        .to_string();
    // Download and convert to data URL, same as image
}
```

**Add `file` field to `WeComMsgCallback`:**
```rust
#[serde(default)]
file: Option<serde_json::Value>,
```

**Download and forward:** Reuse `download_image_as_data_url()` (rename to `download_media_as_data_url()`). Detect MIME from Content-Type header or filename extension. Send to OpenCode as a `file` part with the detected MIME and original filename.

---

## C. Events & Template Cards

### C1. Event callback handling

**Problem:** `aibot_event_callback` is a no-op placeholder.

**Change in `handle_ws_message()` — `aibot_event_callback` branch:**

Parse `body.event.eventtype` and dispatch:

```rust
"aibot_event_callback" => {
    if let Some(body) = msg.body {
        let eventtype = body.get("event")
            .and_then(|e| e.get("eventtype"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let req_id = msg.headers...;  // extract req_id
        match eventtype {
            "enter_chat" => self.handle_enter_chat(&req_id, &ws_sink).await,
            "template_card_event" => self.handle_template_card_event(&body, &req_id, &ws_sink).await,
            "disconnected_event" => println!("[WeCom] Disconnected by server (new connection established)"),
            "feedback_event" => println!("[WeCom] User feedback received"),
            _ => println!("[WeCom] Unhandled event: {}", eventtype),
        }
    }
}
```

### C2. Welcome message (`enter_chat`)

**New method `handle_enter_chat()`:**

Send `aibot_respond_welcome_msg` with fixed text:

```json
{
  "cmd": "aibot_respond_welcome_msg",
  "headers": { "req_id": "<from_callback>" },
  "body": {
    "msgtype": "text",
    "text": { "content": "你好！我是 AI 助手。直接发消息给我开始对话，发送 /help 查看可用命令。" }
  }
}
```

Must be sent within 5 seconds of receiving the event. Since this is a simple WebSocket send, timing is not a concern.

### C3. Template card for questions

**When `question.asked` fires and the question has options:**

Instead of formatting as text, send a `template_card` with `button_interaction` type.

**Multiple questions:** Each question with options gets its own card. Questions without options use existing text format.

**Card structure:**

```json
{
  "cmd": "aibot_respond_msg",
  "headers": { "req_id": "<from_callback>" },
  "body": {
    "msgtype": "template_card",
    "template_card": {
      "card_type": "button_interaction",
      "main_title": { "title": "AI Question" },
      "sub_title_text": "<question text>",
      "button_list": [
        { "text": "Yes", "style": 1, "key": "q:abc123:0:yes" },
        { "text": "No",  "style": 1, "key": "q:abc123:1:no" }
      ],
      "task_id": "q:abc123"
    }
  }
}
```

**Button key encoding:** `q:{question_id}:{option_index}:{option_value}`

The `task_id` is set to `q:{question_id}` for correlation.

**Where this logic lives:**

In the WeCom-specific SSE handler (the `question.asked` branch inside `stream_opencode_to_wecom`), not in the shared `pending_question.rs`. The shared module stays as-is for other channels. WeCom overrides the question forwarding to use cards when options are present.

### C4. Template card event handling

**New method `handle_template_card_event()`:**

1. Parse the event body to extract the clicked button's `key` and the `task_id`
2. Decode key: split `q:{question_id}:{option_index}:{option_value}`
3. Look up the pending question by `question_id` in `PendingQuestionStore`
4. Send the answer via `answer_tx.send(option_value)`
5. Within 5 seconds, send `aibot_respond_update_msg` to update the card:
   - Clicked button: `style: 1` (highlighted blue)
   - Other buttons: `style: 2` (grey)

**Update card command:**

```json
{
  "cmd": "aibot_respond_update_msg",
  "headers": { "req_id": "<from_event_callback>" },
  "body": {
    "response_type": "update_template_card",
    "template_card": {
      "card_type": "button_interaction",
      "main_title": { "title": "AI Question" },
      "sub_title_text": "<original question text>",
      "button_list": [
        { "text": "✓ Yes", "style": 1, "key": "q:abc123:0:yes" },
        { "text": "No",    "style": 2, "key": "q:abc123:1:no" }
      ],
      "task_id": "q:abc123"
    }
  }
}
```

**Storing question metadata for card updates:**

The `PendingQuestionEntry` currently stores `question_id` and `answer_tx`. For card updates, we also need to remember the original question text, options, and which card was sent. Add a small `CardMetadata` struct stored alongside the pending question in a separate map on `WeComGateway`:

```rust
struct CardMetadata {
    question_text: String,
    options: Vec<QuestionOption>,
    req_id: String,
}
// Stored in: HashMap<String, CardMetadata> keyed by question_id
```

This stays on `WeComGateway`, not in the shared `PendingQuestionStore`.

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/commands/gateway/wecom.rs` | A1-A3, B1, C1-C4: all backend changes |
| `src-tauri/src/commands/cron/delivery.rs` | A1: parse `single:`/`group:` prefix |
| `src-tauri/src/commands/cron/scheduler.rs` | A1: update session key mapping |
| `packages/app/src/lib/cron-utils.ts` | A1: WeCom registry modes + fields |

## Testing

- **A1:** Create cron job targeting `single:{userid}`, verify message arrives as single chat
- **A2:** Verify cron push renders as formatted markdown in WeCom
- **A3:** Verify gateway stays connected over 5+ minutes (heartbeat working)
- **B1:** Send a file to bot in WeCom single chat, verify AI receives and processes it
- **C1-C2:** Enter bot single chat for first time today, verify welcome message appears
- **C3-C4:** Trigger a permission question, verify card appears with buttons, click a button, verify card updates and AI receives the answer
