# WeCom QR Code Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add QR code scanning as the primary method for WeCom bot credential setup, with manual input as fallback.

**Architecture:** Two new Tauri commands (`start_wecom_qr_auth`, `poll_wecom_qr_auth`) proxy WeCom's QR auth API. Frontend restructures the setup wizard to add a "choose method" step and a QR scan step, reusing the existing `qrcode.react` library and the polling pattern from the WeChat channel.

**Tech Stack:** Rust (reqwest for HTTP), TypeScript/React (qrcode.react for QR rendering), Tauri IPC

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/commands/gateway/wecom.rs` | Modify | Add `fetch_qr_code()` and `poll_qr_result()` functions |
| `src-tauri/src/commands/gateway/wecom_config.rs` | Modify | Add QR auth response types |
| `src-tauri/src/commands/gateway/mod.rs` | Modify | Add `start_wecom_qr_auth` and `poll_wecom_qr_auth` Tauri commands |
| `src-tauri/src/lib.rs` | Modify | Register new commands |
| `packages/app/src/stores/channels/wecom.ts` | Modify | Add `startWecomQrAuth` and `pollWecomQrAuth` store actions |
| `packages/app/src/stores/channels-types.ts` | Modify | Add QR auth TypeScript types |
| `packages/app/src/components/settings/channels/Wecom.tsx` | Modify | Restructure wizard: add choose-method step and QR scan step |
| `packages/app/src/locales/en.json` | Modify | Add English translation keys |
| `packages/app/src/locales/zh-CN.json` | Modify | Add Chinese translation keys |

---

### Task 1: Add QR Auth Response Types (Rust)

**Files:**
- Modify: `src-tauri/src/commands/gateway/wecom_config.rs`

- [ ] **Step 1: Add QR auth response structs**

Add these types after the existing `WeComGatewayStatusResponse` impl block at the end of the file:

```rust
/// Response from WeCom QR code generate API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrGenerateResponse {
    pub data: Option<WeComQrGenerateData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrGenerateData {
    pub scode: String,
    pub auth_url: String,
}

/// Response from WeCom QR code poll API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrPollResponse {
    pub data: Option<WeComQrPollData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrPollData {
    pub status: String,
    pub bot_info: Option<WeComQrBotInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrBotInfo {
    pub botid: String,
    pub secret: String,
}

/// Tauri-facing QR generate result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComQrAuthStart {
    pub scode: String,
    pub auth_url: String,
}

/// Tauri-facing QR poll result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComQrAuthPollResult {
    pub status: String, // "waiting" | "success" | "expired"
    pub bot_id: Option<String>,
    pub secret: Option<String>,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Volumes/openbeta/workspace/teamclaw && cargo check -p teamclaw-app 2>&1 | tail -5`
Expected: No errors related to wecom_config

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/gateway/wecom_config.rs
git commit -m "feat(wecom): add QR auth response types"
```

---

### Task 2: Add QR Auth HTTP Functions (Rust Backend)

**Files:**
- Modify: `src-tauri/src/commands/gateway/wecom.rs`

- [ ] **Step 1: Add platform detection and QR auth functions**

Add these functions near the top of `wecom.rs`, after the existing `compress_image` function (around line 106) and before the `WsSink` type alias:

```rust
/// Get platform code for WeCom QR auth API
fn get_plat_code() -> u8 {
    #[cfg(target_os = "macos")]
    { 1 }
    #[cfg(target_os = "windows")]
    { 2 }
    #[cfg(target_os = "linux")]
    { 3 }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    { 0 }
}

const WECOM_QR_GENERATE_URL: &str = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_POLL_URL: &str = "https://work.weixin.qq.com/ai/qc/query_result";

/// Fetch a QR code for WeCom bot authorization
pub async fn fetch_wecom_qr_code() -> Result<super::wecom_config::WeComQrAuthStart, String> {
    use super::wecom_config::{WeComQrGenerateResponse, WeComQrAuthStart};

    let url = format!("{}?source=teamclaw&plat={}", WECOM_QR_GENERATE_URL, get_plat_code());
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR generate request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR generate failed: HTTP {}", resp.status()));
    }

    let body: WeComQrGenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR generate parse failed: {}", e))?;

    let data = body.data.ok_or("QR generate response missing data")?;
    if data.scode.is_empty() || data.auth_url.is_empty() {
        return Err("QR generate response missing scode or auth_url".into());
    }

    Ok(WeComQrAuthStart {
        scode: data.scode,
        auth_url: data.auth_url,
    })
}

/// Poll WeCom QR code scan result
pub async fn poll_wecom_qr_result(scode: &str) -> Result<super::wecom_config::WeComQrAuthPollResult, String> {
    use super::wecom_config::{WeComQrPollResponse, WeComQrAuthPollResult};

    let url = format!("{}?scode={}", WECOM_QR_POLL_URL, urlencoding::encode(scode));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR poll request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR poll failed: HTTP {}", resp.status()));
    }

    let body: WeComQrPollResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR poll parse failed: {}", e))?;

    let data = match body.data {
        Some(d) => d,
        None => {
            return Ok(WeComQrAuthPollResult {
                status: "waiting".into(),
                bot_id: None,
                secret: None,
            });
        }
    };

    if data.status == "success" {
        let bot_info = data.bot_info.ok_or("QR poll success but missing bot_info")?;
        Ok(WeComQrAuthPollResult {
            status: "success".into(),
            bot_id: Some(bot_info.botid),
            secret: Some(bot_info.secret),
        })
    } else {
        Ok(WeComQrAuthPollResult {
            status: data.status,
            bot_id: None,
            secret: None,
        })
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Volumes/openbeta/workspace/teamclaw && cargo check -p teamclaw-app 2>&1 | tail -5`
Expected: No errors (functions defined but not yet called from commands)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/gateway/wecom.rs
git commit -m "feat(wecom): add QR auth HTTP functions"
```

---

### Task 3: Add Tauri Commands and Register

**Files:**
- Modify: `src-tauri/src/commands/gateway/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add Tauri commands in mod.rs**

Find the `test_wecom_credentials` command in `mod.rs` (around line 2050). Add the two new commands after it:

```rust
/// Start WeCom QR code authorization — returns scode and auth_url
#[tauri::command]
pub async fn start_wecom_qr_auth() -> Result<wecom_config::WeComQrAuthStart, String> {
    wecom::fetch_wecom_qr_code().await
}

/// Poll WeCom QR code authorization result
#[tauri::command]
pub async fn poll_wecom_qr_auth(scode: String) -> Result<wecom_config::WeComQrAuthPollResult, String> {
    wecom::poll_wecom_qr_result(&scode).await
}
```

- [ ] **Step 2: Register commands in lib.rs**

In `src-tauri/src/lib.rs`, find the line `commands::gateway::test_wecom_credentials,` (line 365). Add two lines directly after it:

```rust
            commands::gateway::start_wecom_qr_auth,
            commands::gateway::poll_wecom_qr_auth,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Volumes/openbeta/workspace/teamclaw && cargo check -p teamclaw-app 2>&1 | tail -5`
Expected: Successful compilation

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/gateway/mod.rs src-tauri/src/lib.rs
git commit -m "feat(wecom): register QR auth Tauri commands"
```

---

### Task 4: Add Frontend Types and Store Actions

**Files:**
- Modify: `packages/app/src/stores/channels-types.ts`
- Modify: `packages/app/src/stores/channels/wecom.ts`

- [ ] **Step 1: Add TypeScript types in channels-types.ts**

Find the `WeComGatewayStatusResponse` interface in `channels-types.ts`. Add these types after it:

```typescript
export interface WeComQrAuthStart {
  scode: string
  auth_url: string
}

export interface WeComQrAuthPollResult {
  status: 'waiting' | 'success' | 'expired'
  botId?: string
  secret?: string
}
```

- [ ] **Step 2: Add store actions in wecom.ts**

Add the import for the new types at the top of `wecom.ts`:

```typescript
import type {
  WeComConfig,
  WeComGatewayStatusResponse,
  WeComQrAuthStart,
  WeComQrAuthPollResult,
  ChannelsState,
} from '../channels-types'
```

Add these two new actions inside the `createWecomActions` return object, after the `clearWecomTestResult` action:

```typescript
    startWecomQrAuth: async (): Promise<WeComQrAuthStart> => {
      return await invoke<WeComQrAuthStart>('start_wecom_qr_auth')
    },

    pollWecomQrAuth: async (scode: string): Promise<WeComQrAuthPollResult> => {
      return await invoke<WeComQrAuthPollResult>('poll_wecom_qr_auth', { scode })
    },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors related to wecom types

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/stores/channels-types.ts packages/app/src/stores/channels/wecom.ts
git commit -m "feat(wecom): add QR auth store actions and types"
```

---

### Task 5: Add i18n Translation Keys

**Files:**
- Modify: `packages/app/src/locales/en.json`
- Modify: `packages/app/src/locales/zh-CN.json`

- [ ] **Step 1: Add English translations**

Find the existing `settings.channels.wecom` section in `en.json`. Add these keys within the `wecom` object:

```json
"chooseMethod": "Choose Setup Method",
"chooseMethodDesc": "How would you like to set up your WeCom bot?",
"qrScan": "QR Code Scan",
"qrScanRecommended": "Recommended",
"qrScanDesc": "Scan with WeCom to auto-create bot",
"manualInput": "Manual Input",
"manualInputDesc": "Already have Bot ID and Secret",
"scanTitle": "Scan QR Code",
"scanDesc": "Use WeCom to scan the QR code below.",
"loadingQr": "Generating QR code...",
"scanInstructions": "Open WeCom on your phone and scan this QR code to authorize.",
"waitingScan": "Waiting for scan...",
"scanSuccess": "Authorization successful! Credentials obtained.",
"scanTimeout": "QR code expired. Please try again.",
"scanError": "Failed to get QR code. Please try again or use manual input.",
"retryQr": "Retry",
"switchToManual": "Switch to Manual Input"
```

- [ ] **Step 2: Add Chinese translations**

Find the existing `settings.channels.wecom` section in `zh-CN.json`. Add these keys within the `wecom` object:

```json
"chooseMethod": "选择接入方式",
"chooseMethodDesc": "你想如何设置企微机器人？",
"qrScan": "扫码接入",
"qrScanRecommended": "推荐",
"qrScanDesc": "用企业微信扫码，自动创建机器人",
"manualInput": "手动输入",
"manualInputDesc": "已有 Bot ID 和 Secret",
"scanTitle": "扫描二维码",
"scanDesc": "使用企业微信扫描下方二维码",
"loadingQr": "正在生成二维码...",
"scanInstructions": "打开手机上的企业微信，扫描此二维码进行授权。",
"waitingScan": "等待扫码中...",
"scanSuccess": "授权成功！已自动获取凭证。",
"scanTimeout": "二维码已过期，请重试。",
"scanError": "获取二维码失败，请重试或使用手动输入。",
"retryQr": "重试",
"switchToManual": "切换为手动输入"
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "feat(wecom): add QR auth i18n translations"
```

---

### Task 6: Restructure Setup Wizard UI

**Files:**
- Modify: `packages/app/src/components/settings/channels/Wecom.tsx`

This is the largest task. We restructure the `WeComSetupWizard` from 4 steps to 5 steps (intro → choose method → scan OR manual → complete), following the exact same pattern used in `Wechat.tsx` for QR rendering and polling.

- [ ] **Step 1: Update wizard step definitions**

Replace the existing `WECOM_WIZARD_STEPS` array at the top of the file:

```typescript
const WECOM_WIZARD_STEPS = [
  {
    id: 'intro',
    titleKey: 'settings.channels.wecom.wizardIntroTitle',
    title: 'Welcome to WeCom Setup',
    descKey: 'settings.channels.wecom.wizardIntroDesc',
    description: `Let's connect your WeCom AI bot to ${buildConfig.app.name} in a few simple steps.`,
  },
  {
    id: 'choose-method',
    titleKey: 'settings.channels.wecom.chooseMethod',
    title: 'Choose Setup Method',
    descKey: 'settings.channels.wecom.chooseMethodDesc',
    description: 'How would you like to set up your WeCom bot?',
  },
  {
    id: 'qr-scan',
    titleKey: 'settings.channels.wecom.scanTitle',
    title: 'Scan QR Code',
    descKey: 'settings.channels.wecom.scanDesc',
    description: 'Use WeCom to scan the QR code below.',
  },
  {
    id: 'get-credentials',
    titleKey: 'settings.channels.wecom.wizardCredentialsTitle',
    title: 'Get Your Bot Credentials',
    descKey: 'settings.channels.wecom.wizardCredentialsDesc',
    description: 'Copy your Bot ID and Secret.',
  },
  {
    id: 'complete',
    titleKey: 'settings.channels.wecom.wizardCompleteTitle',
    title: 'Setup Complete!',
    descKey: 'settings.channels.wecom.wizardCompleteDesc',
    description: 'Your WeCom bot is ready to use.',
  },
]
```

- [ ] **Step 2: Add imports and state**

Add to the imports at the top of the file:

```typescript
import { QRCodeSVG } from 'qrcode.react'
```

Add `ScanQrCode` to the lucide-react import list (alongside existing icons).

Update the `WeComSetupWizard` function signature to accept store actions:

```typescript
function WeComSetupWizard({
  open,
  onOpenChange,
  onCredentialsSave,
  existingBotId,
  existingSecret,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialsSave: (botId: string, secret: string) => void
  existingBotId?: string
  existingSecret?: string
}) {
```

Add new state variables inside the wizard component, after the existing `secret` state:

```typescript
  const [method, setMethod] = React.useState<'qr' | 'manual' | null>(null)
  const [qrAuthUrl, setQrAuthUrl] = React.useState<string | null>(null)
  const [qrScode, setQrScode] = React.useState<string | null>(null)
  const [qrLoading, setQrLoading] = React.useState(false)
  const [qrError, setQrError] = React.useState<string>('')
  const [scanStatus, setScanStatus] = React.useState<string>('')
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const errorCountRef = React.useRef(0)

  const { startWecomQrAuth, pollWecomQrAuth } = useChannelsStore()
```

- [ ] **Step 3: Add QR code fetch and polling logic**

Add these functions inside the wizard component, after the state declarations:

```typescript
  const cleanupPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    errorCountRef.current = 0
  }

  React.useEffect(() => {
    if (open) {
      setStep(0)
      setBotId(existingBotId || '')
      setSecret(existingSecret || '')
      setMethod(null)
      setQrAuthUrl(null)
      setQrScode(null)
      setQrLoading(false)
      setQrError('')
      setScanStatus('')
      cleanupPolling()
    }
    return () => cleanupPolling()
  }, [open, existingBotId, existingSecret])

  const fetchQrCode = async () => {
    setQrLoading(true)
    setQrError('')
    setScanStatus('')
    cleanupPolling()
    try {
      const data = await startWecomQrAuth()
      setQrAuthUrl(data.auth_url)
      setQrScode(data.scode)
      setQrLoading(false)

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const result = await pollWecomQrAuth(data.scode)
          errorCountRef.current = 0
          if (result.status === 'success' && result.botId && result.secret) {
            cleanupPolling()
            setScanStatus('success')
            setBotId(result.botId)
            setSecret(result.secret)
            onCredentialsSave(result.botId, result.secret)
            // Advance to complete step
            setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'complete'))
          }
        } catch {
          errorCountRef.current++
          if (errorCountRef.current >= 3) {
            cleanupPolling()
            setQrError(t('settings.channels.wecom.scanError', 'Failed to get QR code. Please try again or use manual input.'))
          }
        }
      }, 3000)

      // Auto-expire after 5 minutes
      setTimeout(() => {
        if (pollRef.current) {
          cleanupPolling()
          setQrError(t('settings.channels.wecom.scanTimeout', 'QR code expired. Please try again.'))
          setQrAuthUrl(null)
        }
      }, 300000)
    } catch (e) {
      setQrLoading(false)
      setQrError(String(e))
    }
  }
```

- [ ] **Step 4: Add the choose-method step rendering**

Add the `'choose-method'` case inside `renderStepContent()`:

```typescript
      case 'choose-method':
        return (
          <div className="space-y-4">
            <div
              className={cn(
                "p-4 rounded-lg border-2 cursor-pointer transition-colors",
                method === 'qr'
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-muted hover:border-blue-300"
              )}
              onClick={() => setMethod('qr')}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-blue-100 dark:bg-blue-900/50">
                  <ScanQrCode className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{t('settings.channels.wecom.qrScan', 'QR Code Scan')}</p>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
                      {t('settings.channels.wecom.qrScanRecommended', 'Recommended')}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{t('settings.channels.wecom.qrScanDesc', 'Scan with WeCom to auto-create bot')}</p>
                </div>
              </div>
            </div>

            <div
              className={cn(
                "p-4 rounded-lg border-2 cursor-pointer transition-colors",
                method === 'manual'
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-muted hover:border-blue-300"
              )}
              onClick={() => setMethod('manual')}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2 bg-muted">
                  <Key className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">{t('settings.channels.wecom.manualInput', 'Manual Input')}</p>
                  <p className="text-sm text-muted-foreground">{t('settings.channels.wecom.manualInputDesc', 'Already have Bot ID and Secret')}</p>
                </div>
              </div>
            </div>
          </div>
        )
```

- [ ] **Step 5: Add the qr-scan step rendering**

Add the `'qr-scan'` case inside `renderStepContent()`:

```typescript
      case 'qr-scan':
        return (
          <div className="space-y-4">
            {!qrAuthUrl && !qrLoading && !qrError && (
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t('settings.channels.wecom.scanInstructions', 'Open WeCom on your phone and scan this QR code to authorize.')}
                </p>
                <Button onClick={fetchQrCode} className="gap-2">
                  <Sparkles className="h-4 w-4" />
                  {t('settings.channels.wecom.getQrCode', 'Get QR Code')}
                </Button>
              </div>
            )}

            {qrLoading && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                <p className="text-sm text-muted-foreground">{t('settings.channels.wecom.loadingQr', 'Generating QR code...')}</p>
              </div>
            )}

            {qrAuthUrl && !qrLoading && (
              <div className="flex flex-col items-center space-y-4">
                <div className="p-4 bg-white rounded-xl shadow-sm border">
                  <QRCodeSVG value={qrAuthUrl} size={200} level="M" />
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  {t('settings.channels.wecom.scanInstructions', 'Open WeCom on your phone and scan this QR code to authorize.')}
                </p>
                {scanStatus !== 'success' && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('settings.channels.wecom.waitingScan', 'Waiting for scan...')}
                  </div>
                )}
                {scanStatus === 'success' && (
                  <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    {t('settings.channels.wecom.scanSuccess', 'Authorization successful! Credentials obtained.')}
                  </div>
                )}
              </div>
            )}

            {qrError && (
              <div className="text-center space-y-3">
                <div className="flex items-center justify-center gap-2 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {qrError}
                </div>
                <div className="flex justify-center gap-2">
                  <Button variant="outline" onClick={fetchQrCode} size="sm" className="gap-1">
                    {t('settings.channels.wecom.retryQr', 'Retry')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMethod('manual')
                      setQrError('')
                      setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'get-credentials'))
                    }}
                  >
                    {t('settings.channels.wecom.switchToManual', 'Switch to Manual Input')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
```

- [ ] **Step 6: Update navigation logic**

Replace the existing `handleNext` function:

```typescript
  const handleNext = () => {
    const currentId = WECOM_WIZARD_STEPS[step]?.id
    if (currentId === 'choose-method') {
      if (method === 'qr') {
        const qrStep = WECOM_WIZARD_STEPS.findIndex(s => s.id === 'qr-scan')
        setStep(qrStep)
        // Auto-fetch QR code when entering scan step
        setTimeout(() => fetchQrCode(), 100)
      } else {
        const manualStep = WECOM_WIZARD_STEPS.findIndex(s => s.id === 'get-credentials')
        setStep(manualStep)
      }
    } else if (step < WECOM_WIZARD_STEPS.length - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    const currentId = WECOM_WIZARD_STEPS[step]?.id
    if (currentId === 'qr-scan' || currentId === 'get-credentials') {
      cleanupPolling()
      setQrAuthUrl(null)
      setQrError('')
      setStep(WECOM_WIZARD_STEPS.findIndex(s => s.id === 'choose-method'))
    } else if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleClose = () => {
    cleanupPolling()
    onOpenChange(false)
  }
```

- [ ] **Step 7: Update the Next button disabled logic in DialogFooter**

Update the Next button's `disabled` prop to handle the new steps:

```typescript
  disabled={
    (WECOM_WIZARD_STEPS[step]?.id === 'choose-method' && !method) ||
    (WECOM_WIZARD_STEPS[step]?.id === 'get-credentials' && (!botId || !secret)) ||
    WECOM_WIZARD_STEPS[step]?.id === 'qr-scan'
  }
```

The QR scan step disables "Next" because navigation is automatic on success. Also hide the Next button entirely on the `qr-scan` step since navigation is auto-triggered.

Update the dialog's `onOpenChange` to use `handleClose`:

```typescript
<Dialog open={open} onOpenChange={handleClose}>
```

- [ ] **Step 8: Verify the app builds**

Run: `cd /Volumes/openbeta/workspace/teamclaw/packages/app && npx tsc --noEmit 2>&1 | tail -10`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/components/settings/channels/Wecom.tsx
git commit -m "feat(wecom): add QR code scan to setup wizard"
```

---

### Task 7: Manual Testing and Final Verification

- [ ] **Step 1: Build the Rust backend**

Run: `cd /Volumes/openbeta/workspace/teamclaw && cargo build -p teamclaw-app 2>&1 | tail -10`
Expected: Successful build

- [ ] **Step 2: Build the frontend**

Run: `cd /Volumes/openbeta/workspace/teamclaw/packages/app && npm run build 2>&1 | tail -10`
Expected: Successful build

- [ ] **Step 3: Verify new Tauri commands are registered**

Run: `cd /Volumes/openbeta/workspace/teamclaw && grep -n "wecom_qr_auth" src-tauri/src/lib.rs`
Expected: Both `start_wecom_qr_auth` and `poll_wecom_qr_auth` listed

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(wecom): address QR auth build issues"
```
