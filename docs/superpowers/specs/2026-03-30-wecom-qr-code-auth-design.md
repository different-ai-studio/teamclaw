# WeCom QR Code Authentication Design

## Overview

Add QR code scanning as the primary method for WeCom bot credential setup, with manual input as a fallback. Users scan a QR code with their WeCom app to automatically create a bot and obtain `botId` and `secret`, eliminating the need to navigate the WeCom admin console.

## Background

WeCom recently launched a QR code authorization API (`https://work.weixin.qq.com/ai/qc/`) that enables programmatic bot creation via scan. The official `@wecom/wecom-openclaw-cli` already implements this flow. We adapt the same API for our Tauri desktop app.

### WeCom QR Auth API

1. **Generate QR code**: `GET https://work.weixin.qq.com/ai/qc/generate?source=teamclaw&plat={plat_code}`
   - `plat_code`: macOS=1, Windows=2, Linux=3
   - Returns `{ data: { scode: string, auth_url: string } }`

2. **Poll result**: `GET https://work.weixin.qq.com/ai/qc/query_result?scode={scode}`
   - Returns `{ data: { status: "waiting" | "success", bot_info?: { botid: string, secret: string } } }`

3. **QR web fallback**: `https://work.weixin.qq.com/ai/qc/gen?source=teamclaw&scode={scode}`

## Architecture

### Approach: Backend Proxy (Rust)

All WeCom API calls go through Rust backend via Tauri IPC commands, consistent with the existing architecture where all WeCom logic resides in the backend.

## Backend Design

### New Tauri Commands

Two new commands in `wecom.rs`:

#### `start_wecom_qr_auth`

- Calls the WeCom generate API
- Returns `{ scode: String, auth_url: String }` to the frontend
- No state kept on backend; stateless request

#### `poll_wecom_qr_auth(scode: String)`

- Calls the WeCom query_result API with the given `scode`
- Returns `{ status: "waiting" | "success" | "expired", bot_id: Option<String>, secret: Option<String> }`
- Single request per call; frontend controls polling schedule

### Why Frontend Polls (Not Backend)

- Frontend can directly manage UI state (loading, timeout, cancel)
- Avoids long-blocking Tauri commands
- User can close the dialog to cancel at any time

## Frontend Design

### Modified Setup Wizard Flow

The existing `WeComSetupWizard` (4 steps) is restructured:

| Step | Content |
|------|---------|
| 1. Intro | Welcome page (unchanged) |
| 2. Choose method | **QR scan** (recommended) or **Manual input** |
| 3a. QR scan | Display QR code, poll for result, auto-fill credentials |
| 3b. Manual input | Existing Bot ID + Secret form (unchanged) |
| 4. Complete | Setup complete (unchanged) |

### Step 2: Choose Method

Two selectable cards:
- **QR Scan** (recommended badge): "Scan with WeCom to auto-create bot"
- **Manual Input**: "Already have Bot ID and Secret"

### Step 3a: QR Scan Flow

1. Call `start_wecom_qr_auth` via Tauri IPC
2. Render `auth_url` as QR code image using `qrcode` npm package
3. Show "Scan with WeCom" prompt
4. Poll `poll_wecom_qr_auth(scode)` every 3 seconds
5. On success: auto-fill `botId` and `secret` into config, advance to step 4
6. On 5-minute timeout: show retry button to regenerate QR code

### Dependencies

- `qrcode` npm package (for rendering QR code in the dialog)

## Data Flow

```
User clicks "QR Scan"
  -> Frontend calls start_wecom_qr_auth (Tauri IPC)
  -> Rust calls WeCom generate API -> returns { scode, auth_url }
  -> Frontend renders auth_url as QR image via qrcode lib
  -> Frontend polls poll_wecom_qr_auth(scode) every 3s
  -> Rust calls WeCom query_result API -> returns status
  -> status=success -> Frontend receives botId+secret -> writes to localConfig -> advances to complete step
```

After credential acquisition, the flow is identical to manual input: save config, start gateway via WebSocket.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Generate API request failure | Show error message + retry button |
| Poll timeout (5 minutes) | Show "timed out" + regenerate QR button |
| Single poll error | Silently ignore; after 3 consecutive failures, show error |
| User closes dialog | Clear poll interval timer, no side effects |
| Scan success but missing credentials | Show error, guide user to manual input |

## What Does NOT Change

- `WeComConfig` struct (still `botId` + `secret` + `encodingAesKey`)
- WebSocket connection logic
- Gateway start/stop logic
- Config persistence logic
- All message handling (callbacks, streaming, proactive messages)

QR scan is purely a new credential acquisition entry point. Everything downstream remains the same.

## Files to Modify

| File | Changes |
|------|---------|
| `src-tauri/src/commands/gateway/wecom.rs` | Add `start_wecom_qr_auth` and `poll_wecom_qr_auth` functions |
| `src-tauri/src/commands/gateway/mod.rs` | Export new functions as Tauri commands |
| `src-tauri/src/lib.rs` | Register new Tauri commands in invoke handler |
| `packages/app/src/components/settings/channels/Wecom.tsx` | Restructure wizard steps, add QR scan UI |
| `packages/app/src/stores/channels/wecom.ts` | Add store actions for QR auth commands |
| `packages/app/package.json` | Add `qrcode` dependency |
| i18n files | Add translation keys for new UI strings |
