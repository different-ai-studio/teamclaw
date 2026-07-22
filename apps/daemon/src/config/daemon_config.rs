use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    /// Actor identity for this daemon. `id` is the actor_id (routing
    /// identity used in `amux/{team}/{actor}/...` topics); `name` is a
    /// human host/daemon label. Accepts the legacy `[device]` section via
    /// serde alias so existing `daemon.toml` files keep parsing.
    #[serde(rename = "actor", alias = "device")]
    pub actor: ActorConfig,
    pub mqtt: MqttConfig,
    /// Transport selector. Defaults to MQTT when omitted so existing
    /// `daemon.toml` files keep working unchanged. Set
    /// `[transport] kind = "nats"` + `url = "nats://..."` to use NATS.
    #[serde(default)]
    pub transport: Option<TransportConfig>,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub channels: ChannelsConfig,
    /// Stop ACP runtimes whose `last_active_at` is older than this many
    /// seconds. `None` (default) disables idle eviction. Manual stops via
    /// the RuntimeStop RPC are unaffected. Recommend ≥ 1800 (30 min) so
    /// users don't lose context mid-conversation; very short values will
    /// kill mid-stream replies that exceed the threshold.
    #[serde(default)]
    pub idle_runtime_timeout_secs: Option<u64>,
    /// Browser-facing HTTP/SSE API, bound alongside the Unix control socket.
    ///
    /// Omitting the section does **not** disable the listener — the daemon
    /// falls back to `HttpConfig::default()` (loopback, ephemeral port). The
    /// section only exists to override those defaults. The listener is how the
    /// setup UI is served, so an unconfigured daemon needs it most.
    #[serde(default)]
    pub http: Option<HttpConfig>,
}

/// Configuration for the browser-facing HTTP+SSE listener. Defaults are tuned
/// for "localhost browser connecting to a single user's daemon"; cross-host
/// deployments must set `bind` + a TLS terminator in front.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpConfig {
    /// Socket address to bind. Use `127.0.0.1:0` (default) to pick an
    /// ephemeral loopback port — the actual port is written to
    /// `<config_dir>/amuxd.http.port` so clients can discover it.
    #[serde(default = "default_http_bind")]
    pub bind: String,
    /// Origins allowed by the CORS layer. `*` is rejected; supply
    /// concrete origins like `http://localhost:5173`. Empty list disables
    /// CORS (same-origin only).
    #[serde(default = "default_allowed_origins")]
    pub allowed_origins: Vec<String>,
    /// Idle session TTL. Sessions with no activity for this long are
    /// closed and removed from the registry.
    #[serde(default = "default_session_idle_ttl", with = "humantime_serde")]
    pub session_idle_ttl: std::time::Duration,
    /// SSE comment-frame heartbeat interval.
    #[serde(default = "default_heartbeat_interval", with = "humantime_serde")]
    pub heartbeat_interval: std::time::Duration,
    /// Max sessions a single session-token may own concurrently.
    #[serde(default = "default_max_sessions_per_token")]
    pub max_sessions_per_token: u32,
    /// Per-session event ring buffer size. Drives `Last-Event-ID` replay
    /// window — events beyond this point return `410 Gone`.
    #[serde(default = "default_max_event_backlog")]
    pub max_event_backlog: usize,
    /// Per-token request rate (sustained req/sec). Bursts allowed up to
    /// `rate_limit_burst`.
    #[serde(default = "default_rate_limit_rps")]
    pub rate_limit_rps: u32,
    #[serde(default = "default_rate_limit_burst")]
    pub rate_limit_burst: u32,
    /// Max concurrent SSE streams per token.
    #[serde(default = "default_max_sse_per_token")]
    pub max_sse_per_token: u32,
    /// Hard cap on POST body size in bytes (applies to /prompt etc.).
    #[serde(default = "default_max_body_bytes")]
    pub max_body_bytes: usize,
    /// Root-token file. Mode 0600. Auto-generated if missing on startup.
    #[serde(default)]
    pub token_file: Option<PathBuf>,
    /// File that receives the actually-bound port (useful when `bind`
    /// uses port 0). Defaults to `<config_dir>/amuxd.http.port`.
    #[serde(default)]
    pub port_file: Option<PathBuf>,
    /// Default scopes granted to session tokens minted via
    /// `POST /v1/auth/exchange` when the caller does not pass `scopes`.
    #[serde(default = "default_scopes")]
    pub default_scopes: Vec<String>,
}

fn default_allowed_origins() -> Vec<String> {
    // TeamClaw desktop (Tauri devUrl + packaged WebView2 origins) and Vite dev.
    vec![
        "http://127.0.0.1:1420".into(),
        "http://localhost:1420".into(),
        "http://127.0.0.1:5173".into(),
        "http://localhost:5173".into(),
        "tauri://localhost".into(),
        "https://tauri.localhost".into(),
        // WebView2 may emit http (not https) for the tauri.localhost scheme.
        "http://tauri.localhost".into(),
        // Tauri 2 asset protocol fallback seen on some Windows builds.
        "https://asset.localhost".into(),
    ]
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            bind: default_http_bind(),
            allowed_origins: default_allowed_origins(),
            session_idle_ttl: default_session_idle_ttl(),
            heartbeat_interval: default_heartbeat_interval(),
            max_sessions_per_token: default_max_sessions_per_token(),
            max_event_backlog: default_max_event_backlog(),
            rate_limit_rps: default_rate_limit_rps(),
            rate_limit_burst: default_rate_limit_burst(),
            max_sse_per_token: default_max_sse_per_token(),
            max_body_bytes: default_max_body_bytes(),
            token_file: None,
            port_file: None,
            default_scopes: default_scopes(),
        }
    }
}

fn default_http_bind() -> String {
    "127.0.0.1:0".into()
}
fn default_session_idle_ttl() -> std::time::Duration {
    std::time::Duration::from_secs(30 * 60)
}
fn default_heartbeat_interval() -> std::time::Duration {
    std::time::Duration::from_secs(15)
}
fn default_max_sessions_per_token() -> u32 {
    32
}
fn default_max_event_backlog() -> usize {
    1024
}
fn default_rate_limit_rps() -> u32 {
    20
}
fn default_rate_limit_burst() -> u32 {
    60
}
fn default_max_sse_per_token() -> u32 {
    8
}
fn default_max_body_bytes() -> usize {
    1024 * 1024
}
fn default_scopes() -> Vec<String> {
    // Least privilege: a token minted without an explicit `scopes` list can read
    // sessions/events/workspace config but must request `workspace:write`
    // explicitly to mutate provider/permission/MCP/skill/role state. The desktop
    // client always requests the scopes it needs, so this only narrows the
    // implicit fallback grant.
    vec![
        "sessions:read".into(),
        "sessions:write".into(),
        "events:read".into(),
        "workspace:read".into(),
    ]
}

/// Placeholder `actor.name` written by [`DaemonConfig::bootstrap`].
///
/// Onboarding replaces it with the cloud display name (see
/// `daemon_config_for_invite`). A name that is *not* this sentinel was chosen
/// by the operator and is preserved across re-onboarding.
pub const BOOTSTRAP_ACTOR_NAME: &str = "amuxd (unclaimed)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorConfig {
    /// Actor id — the routing identity for this daemon. Used in topic
    /// paths `amux/{team}/{actor}/...`.
    pub id: String,
    /// Human-friendly host/daemon label (e.g. machine name).
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    pub broker_url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Top-level transport switch. When present and `kind = "nats"`, the
/// daemon connects to `url` instead of `mqtt.broker_url`. URL scheme
/// (`nats://`, `tls://`, `ws://`, `wss://`) is forwarded verbatim to
/// async-nats.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportConfig {
    #[serde(default = "default_transport_kind")]
    pub kind: TransportKind,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    Mqtt,
    Nats,
}

fn default_transport_kind() -> TransportKind {
    TransportKind::Mqtt
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    /// When true (default), amuxd probes the host for agent binaries on start
    /// and writes missing `[agents.*]` sections to `daemon.toml`.
    #[serde(default = "default_true")]
    pub auto_discover: bool,
    /// Local agent runtime backing this daemon: "opencode" (default) or "pi".
    /// Seeded from the desktop build config's `localAgent` during onboarding.
    /// Only "opencode" is implemented today; "pi" is reserved for the pi RPC
    /// backend (docs/architecture/pi-agent-backend.md) and currently falls
    /// back to opencode with a warning.
    #[serde(default = "default_local_agent")]
    pub local_agent: String,
    #[serde(default)]
    pub claude_code: Option<AgentBackendConfig>,
    #[serde(default)]
    pub opencode: Option<AgentBackendConfig>,
    #[serde(default)]
    pub codex: Option<AgentBackendConfig>,
}

fn default_local_agent() -> String {
    "opencode".to_string()
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self {
            auto_discover: true,
            local_agent: default_local_agent(),
            claude_code: None,
            opencode: None,
            codex: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendConfig {
    #[serde(default = "default_claude_binary")]
    pub binary: String,
    #[serde(default)]
    pub default_flags: Vec<String>,
}

fn default_claude_binary() -> String {
    "claude".into()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ChannelsConfig {
    #[serde(default)]
    pub discord: Option<DiscordChannel>,
    #[serde(default)]
    pub wecom: Option<WeComChannel>,
    #[serde(default)]
    pub feishu: Option<FeishuChannel>,
    #[serde(default)]
    pub kook: Option<KookChannel>,
    #[serde(default)]
    pub wechat: Option<WeChatChannel>,
    #[serde(default)]
    pub email: Option<EmailChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordChannel {
    pub enabled: bool,
    pub bot_token: String,
    #[serde(default)]
    pub default_username: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComBot {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub bot_id: String,
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding_aes_key: Option<String>,
    /// Workspace this bot's sessions run in (resolved against workspaces.toml).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Backend: "claude-code" | "opencode" | "codex". None -> daemon default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Per-bot system prompt injected into the first turn + CLAUDE.local.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComChannel {
    pub enabled: bool,
    // ----- legacy single-bot fields (kept for back-compat) -----
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding_aes_key: Option<String>,
    // ----- new multi-bot list -----
    #[serde(default)]
    pub bots: Vec<WeComBot>,
}

impl WeComChannel {
    /// Normalize to a flat bot list: prefer the explicit `bots` array; if it
    /// is empty, synthesize a single bot from the legacy top-level fields.
    pub fn resolved_bots(&self) -> Vec<WeComBot> {
        if !self.bots.is_empty() {
            return self.bots.clone();
        }
        if self.bot_id.is_empty() {
            return vec![];
        }
        vec![WeComBot {
            enabled: true,
            bot_id: self.bot_id.clone(),
            secret: self.secret.clone(),
            encoding_aes_key: self.encoding_aes_key.clone(),
            workspace_id: None,
            agent_type: None,
            system_prompt: None,
        }]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuChannel {
    pub enabled: bool,
    pub app_id: String,
    pub app_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KookChannel {
    pub enabled: bool,
    pub bot_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeChatChannel {
    pub enabled: bool,
    pub ilink_account: String,
    pub ilink_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailChannel {
    pub enabled: bool,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_user: String,
    pub imap_pass: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_pass: String,
    #[serde(default)]
    pub allowed_senders: Vec<String>,
}

impl DaemonConfig {
    pub fn config_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join(".amuxd")
    }

    pub fn legacy_config_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| Self::config_dir())
            .join("amux")
    }

    pub fn default_path() -> PathBuf {
        Self::migrate_legacy_file("daemon.toml")
    }

    pub fn migrate_legacy_file(file_name: &str) -> PathBuf {
        let path = Self::config_dir().join(file_name);
        let legacy_path = Self::legacy_config_dir().join(file_name);
        if !path.exists() && legacy_path.exists() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::copy(&legacy_path, &path);
        }
        path
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    /// A config for a daemon that has not been onboarded yet.
    ///
    /// `broker_url` is deliberately empty: the daemon resolves the broker from
    /// `/v1/config/bootstrap` once it has credentials, and runs MQTT on a
    /// placeholder client until then. `actor.id` is a locally-minted
    /// placeholder — onboarding overwrites it with the cloud's actor_id, which
    /// MQTT topic ACLs are keyed on.
    pub fn bootstrap() -> Self {
        Self {
            actor: ActorConfig {
                id: uuid::Uuid::new_v4().to_string(),
                name: BOOTSTRAP_ACTOR_NAME.to_string(),
            },
            mqtt: MqttConfig {
                broker_url: String::new(),
                username: None,
                password: None,
            },
            transport: None,
            agents: AgentsConfig::default(),
            team_id: None,
            channels: Default::default(),
            idle_runtime_timeout_secs: None,
            // Present so the packaged desktop WebView's fetch() can reach the
            // loopback control plane without a hand edit.
            http: Some(HttpConfig::default()),
        }
    }

    /// Load `path`, or synthesize and persist a [`bootstrap`](Self::bootstrap)
    /// config when it does not exist.
    ///
    /// Persisting immediately is what makes the placeholder `actor.id` stable
    /// across restarts. Deriving it via `#[serde(default)]` instead would mint
    /// a fresh id on every boot and silently re-key MQTT topic ACLs.
    ///
    /// An existing-but-unparseable config still errors — only true absence
    /// bootstraps.
    pub fn load_or_bootstrap(path: &Path) -> crate::error::Result<Self> {
        if path.exists() {
            return Self::load(path);
        }
        let config = Self::bootstrap();
        config.save(path)?;
        tracing::info!(
            path = %path.display(),
            actor_id = %config.actor.id,
            "no daemon.toml — wrote a fresh unconfigured one"
        );
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn pid_path() -> PathBuf {
        Self::config_dir().join("amuxd.pid")
    }

    pub fn lock_path() -> PathBuf {
        Self::config_dir().join("amuxd.lock")
    }

    /// Control endpoint: a Unix socket path on unix, a named-pipe name on
    /// Windows. Pipe names live in a machine-global namespace, so the name
    /// carries the (sanitized) username for per-user uniqueness.
    #[cfg(not(windows))]
    pub fn sock_path() -> PathBuf {
        Self::config_dir().join("amuxd.sock")
    }

    #[cfg(windows)]
    pub fn sock_path() -> PathBuf {
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "default".into());
        PathBuf::from(format!(
            r"\\.\pipe\amuxd-{}",
            Self::control_pipe_suffix_from(&user)
        ))
    }

    /// Sanitize a username into `[A-Za-z0-9_-]` for use inside a pipe name.
    /// Non-ASCII / separator characters map to `-` (multi-byte chars produce
    /// one `-` per char). Kept platform-independent so it is unit-testable
    /// everywhere.
    pub(crate) fn control_pipe_suffix_from(user: &str) -> String {
        user.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    }

    pub fn http_token_path() -> PathBuf {
        Self::config_dir().join("amuxd.http.token")
    }

    /// File the daemon keeps refreshed with the current cloud access token
    /// (JWT), written `0600`. Injected into agent processes as
    /// `TC_ACCESS_TOKEN_FILE` so long-running agents can re-read a fresh token.
    pub fn cloud_token_path() -> PathBuf {
        Self::config_dir().join("amuxd.cloud-token")
    }

    pub fn http_port_path() -> PathBuf {
        Self::config_dir().join("amuxd.http.port")
    }
}

#[cfg(test)]
mod channels_tests {
    use super::*;
    #[test]
    fn channels_roundtrip_wecom() {
        let toml_src = r#"
[actor]
id = "d1"
name = "Mac"

[mqtt]
broker_url = "tcp://localhost:1883"

[agents.opencode]
binary = "opencode"
default_flags = ["acp"]

[channels.wecom]
enabled = true
bot_id = "b1"
secret = "s"
encoding_aes_key = "k"
"#;
        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        assert!(cfg.channels.wecom.is_some());
        assert_eq!(cfg.channels.wecom.as_ref().unwrap().bot_id, "b1");
        assert_eq!(
            cfg.agents
                .opencode
                .as_ref()
                .map(|c| (c.binary.clone(), c.default_flags.clone())),
            Some(("opencode".to_string(), vec!["acp".to_string()]))
        );
    }

    // These parse `WeComChannel` directly rather than a full `DaemonConfig`
    // (which requires a top-level `actor`/`device` section). The TOML body is
    // therefore rooted at the `[channels.wecom]` table, so the bots array is
    // `[[bots]]` here.
    #[test]
    fn wecom_parses_multi_bot_array() {
        let toml = r#"
enabled = true

[[bots]]
bot_id = "botA"
secret = "secretA"
workspace_id = "ws111111"
agent_type = "opencode"
system_prompt = "You are A."

[[bots]]
bot_id = "botB"
secret = "secretB"
"#;
        let wecom: WeComChannel = toml::from_str(toml).unwrap();
        let bots = wecom.resolved_bots();
        assert_eq!(bots.len(), 2);
        assert_eq!(bots[0].bot_id, "botA");
        assert_eq!(bots[0].workspace_id.as_deref(), Some("ws111111"));
        assert_eq!(bots[0].agent_type.as_deref(), Some("opencode"));
        assert_eq!(bots[0].system_prompt.as_deref(), Some("You are A."));
        assert!(bots[1].enabled, "bot enabled defaults to true");
        assert_eq!(bots[1].workspace_id, None);
    }

    #[test]
    fn wecom_legacy_single_bot_is_synthesized_into_one_bot() {
        let toml = r#"
enabled = true
bot_id = "legacy"
secret = "legacysecret"
encoding_aes_key = "k"
"#;
        let wecom: WeComChannel = toml::from_str(toml).unwrap();
        let bots = wecom.resolved_bots();
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].bot_id, "legacy");
        assert_eq!(bots[0].secret, "legacysecret");
        assert_eq!(bots[0].encoding_aes_key.as_deref(), Some("k"));
    }

    #[test]
    fn wecom_empty_yields_no_bots() {
        let wecom: WeComChannel = toml::from_str("enabled = false\n").unwrap();
        assert!(wecom.resolved_bots().is_empty());
    }

    #[test]
    fn legacy_device_section_still_parses_via_alias() {
        let toml_src = r#"
[device]
id = "legacy-actor"
name = "Old Mac"

[mqtt]
broker_url = "tcp://localhost:1883"
"#;
        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        assert_eq!(cfg.actor.id, "legacy-actor");
        assert_eq!(cfg.actor.name, "Old Mac");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_section_without_allowed_origins_uses_desktop_defaults() {
        let cfg: HttpConfig = toml::from_str("[http]\nbind = \"127.0.0.1:0\"\n").unwrap();
        assert!(cfg
            .allowed_origins
            .iter()
            .any(|o| o == "http://tauri.localhost"));
        assert!(cfg
            .allowed_origins
            .iter()
            .any(|o| o == "https://tauri.localhost"));
    }

    #[test]
    fn control_pipe_suffix_sanitizes_to_safe_charset() {
        assert_eq!(DaemonConfig::control_pipe_suffix_from("matt.chow"), "matt-chow");
        // 2 CJK chars + 1 space -> 3 dashes.
        assert_eq!(DaemonConfig::control_pipe_suffix_from("\u{7b80}\u{4f53} user"), "---user");
        assert_eq!(DaemonConfig::control_pipe_suffix_from("Win_User-1"), "Win_User-1");
    }

    #[test]
    fn bootstrap_is_unconfigured_but_serves_http() {
        let cfg = DaemonConfig::bootstrap();
        // Empty broker keeps MQTT on a placeholder client; the HTTP listener is
        // what serves the setup UI, so it must be configured.
        assert!(cfg.mqtt.broker_url.is_empty());
        assert!(cfg.team_id.is_none());
        assert!(cfg.http.is_some());
        assert!(!cfg.actor.id.is_empty());
    }

    #[test]
    fn load_or_bootstrap_persists_a_stable_actor_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");

        let first = DaemonConfig::load_or_bootstrap(&path).unwrap();
        assert!(path.exists(), "bootstrap must persist, or the id would drift");

        // The whole point of persisting: a second start reuses the same actor
        // id rather than silently re-keying MQTT topic ACLs.
        let second = DaemonConfig::load_or_bootstrap(&path).unwrap();
        assert_eq!(first.actor.id, second.actor.id);
    }

    #[test]
    fn load_or_bootstrap_does_not_clobber_a_corrupt_config() {
        // Only true absence bootstraps. Overwriting a broken config would
        // silently discard an operator's credentials/settings.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(&path, "this is not = valid toml [[[").unwrap();

        assert!(DaemonConfig::load_or_bootstrap(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "this is not = valid toml [[["
        );
    }
}
