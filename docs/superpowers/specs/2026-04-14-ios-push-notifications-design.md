# iOS Push Notifications Design

**Date:** 2026-04-14
**Status:** Draft

## Problem

When the iOS app is in the background or closed, users miss Agent replies and collaborative messages. There's no way to notify them that something happened in their sessions.

## Solution

Use JPush (极光推送) to send APNs push notifications from Desktop to iOS. Desktop calls JPush REST API after Agent replies complete or collaborative messages arrive. iOS registers for APNs via JPush SDK and reports its Registration ID to Desktop via MQTT.

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Push service | JPush (极光) | Free tier, good REST API, wraps APNs for global iOS coverage |
| Push sender | Desktop | Already receives Agent replies and collab messages, no extra server needed |
| Timing | Always push | iOS handles foreground suppression natively, simpler than tracking online state |
| Credentials | AppKey/MasterSecret built into Desktop | No user configuration needed |

## Design

### 1. Push Trigger Scenarios

| Scenario | Trigger Location | Notification Content |
|----------|-----------------|---------------------|
| Personal session: Agent reply | `stream_sse_to_mqtt` completes in `mqtt_relay.rs` | `"Agent: {first 50 chars of reply}"` |
| Collab session: Agent reply | `broadcast_agent_reply` in `mqtt_relay.rs` | `"Agent: {first 50 chars of reply}"` |
| Collab session: human message | `handle_collab_chat_request` in `mqtt_relay.rs` | `"{sender_name}: {first 50 chars}"` |

### 2. iOS Integration

#### JPush SDK Setup

- Add JPush iOS SDK via CocoaPods or SPM
- In `TeamClawMobileApp.swift`, on launch:
  1. Call `JPUSHService.setup(withOption:appKey:channel:apsForProduction:)` with the embedded AppKey
  2. Request notification permission via `UNUserNotificationCenter`
  3. Register for APNs: `UIApplication.shared.registerForRemoteNotifications()`
- In AppDelegate callbacks:
  - `didRegisterForRemoteNotificationsWithDeviceToken`: pass token to JPush via `JPUSHService.registerDeviceToken()`
  - JPush callback provides Registration ID

#### Report Registration ID to Desktop

After obtaining JPush Registration ID, publish it to Desktop via MQTT:

Extend `StatusReport` protobuf with a new optional field:

```protobuf
message StatusReport {
  bool online = 1;
  optional string device_name = 2;
  optional string push_registration_id = 3;  // NEW: JPush Registration ID
}
```

iOS publishes `StatusReport` with `push_registration_id` on MQTT connect. Desktop stores this alongside the paired device info.

#### Notification Handling on iOS

- **App in background**: System shows banner notification automatically
- **App in foreground**: Implement `UNUserNotificationCenterDelegate.willPresent` to suppress or show as in-app banner (suppress by default since user already sees MQTT messages)
- **Tap notification**: Deep link to the relevant session via `userInfo` containing `session_id`

### 3. Desktop Integration

#### Store Registration ID

In `mqtt_relay.rs`, when handling `StatusReport` from a paired device:
- Extract `push_registration_id` if present
- Store in `MqttRelay` struct (new field: `push_registration_ids: HashMap<String, String>` mapping device_id → registration_id)

#### Send Push via JPush REST API

Add a helper function in the gateway crate:

```rust
pub async fn send_push_notification(
    app_key: &str,
    master_secret: &str,
    registration_id: &str,
    alert: &str,
    session_id: &str,
) -> Result<(), String>
```

Calls JPush REST API:
```
POST https://api.jpush.cn/v3/push
Authorization: Basic base64({app_key}:{master_secret})

{
  "platform": ["ios"],
  "audience": { "registration_id": ["{registration_id}"] },
  "notification": {
    "ios": {
      "alert": "{alert}",
      "sound": "default",
      "badge": "+1"
    }
  },
  "options": {
    "apns_production": true
  },
  "extras": {
    "session_id": "{session_id}"
  }
}
```

#### Trigger Points

**Personal Agent reply** — after `stream_sse_to_mqtt` finishes (when SSE stream completes with `message.done`):
```rust
// After streaming completes, send push
let alert = format!("Agent: {}", truncate(&full_content, 50));
send_push_notification(app_key, master_secret, &reg_id, &alert, &session_id).await;
```

**Collab Agent reply** — after `broadcast_agent_reply`:
```rust
let alert = format!("Agent: {}", truncate(&content, 50));
// Push to all collab participants' iOS devices
for reg_id in get_collab_push_ids(&session_id) {
    send_push_notification(..., &reg_id, &alert, &session_id).await;
}
```

**Collab human message** — in `handle_collab_chat_request`, after context injection:
```rust
let alert = format!("{}: {}", sender_name, truncate(&content, 50));
// Push to all OTHER participants (not the sender)
for reg_id in get_collab_push_ids_except(&session_id, &sender_device_id) {
    send_push_notification(..., &reg_id, &alert, &session_id).await;
}
```

### 4. JPush Credentials

- **AppKey** and **Master Secret** are obtained from JPush console after creating an app
- Stored as compile-time constants in Rust (via `build.config.json` or environment variables)
- Not exposed to users — fully transparent

### 5. Collab Push Registration

For collaborative sessions, Desktop needs to know the JPush Registration IDs of all participants. Two approaches for non-paired devices (lightweight users):

- Lightweight users report their `push_registration_id` via the same `StatusReport` mechanism on their inbox topic
- Desktop collects all registration IDs for collab session participants

### 6. Badge Management

- Each push increments badge by 1 (`"badge": "+1"`)
- iOS app resets badge to 0 when entering foreground: `UIApplication.shared.applicationIconBadgeNumber = 0`

### 7. Notification Grouping

Use `thread-id` in APNs payload to group notifications by session:

```json
{
  "ios": {
    "alert": "...",
    "thread-id": "session-{session_id}"
  }
}
```

This groups all messages from the same session in iOS notification center.

## Scope

### In Scope
- JPush iOS SDK integration (registration, token handling)
- Registration ID reporting via MQTT StatusReport
- Desktop push sending via JPush REST API
- Three trigger scenarios (personal Agent reply, collab Agent reply, collab human message)
- Notification tap → open relevant session
- Badge count management
- Notification grouping by session

### Out of Scope
- Android push (no Android app)
- Push preferences / mute settings (v1 pushes everything)
- Rich notifications (images, action buttons)
- Desktop push notifications
- Push analytics / delivery tracking
