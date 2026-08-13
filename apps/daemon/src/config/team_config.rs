//! `teams/<id>/state/team.toml` — the team-scoped half of the daemon's config.
//!
//! Holds what changes when the team changes: `[channels]`, `[team_share]` and
//! `local_agent`. `DaemonConfig` keeps these as in-memory fields (every reader
//! is untouched) but no longer serializes them; [`hydrate`] fills them from
//! here at boot and on channel reload.
//!
//! **Credentials never touch this file.** On save, every leaf whose name
//! [`super::edit::is_secret_key`] recognises (bot_token, secret, app_secret,
//! imap_pass, …) is moved into the team's encrypted secret store
//! (`secrets.enc`, `TeamSecrets::channel_secrets`) under a stable dotted path;
//! on load it is injected back. Array elements are keyed by their `bot_id`
//! (`channels.wecom.bots[b-1].secret`), not their index — deleting bot 0 must
//! not silently hand bot 1 someone else's secret.
//!
//! An **empty string** in a secret position on save means "keep what is
//! stored": the desktop form can render placeholders instead of plaintext and
//! save the structure without wiping credentials. Deleting the surrounding
//! channel/bot really does drop the secret — save garbage-collects entries
//! whose path no longer resolves.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use toml::Value;

use super::{ChannelsConfig, TeamShareConfig};

/// The typed shape of `team.toml` (with credentials injected).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TeamFileConfig {
    /// Which runtime this team's agents run ("opencode", "pi", …). `None`
    /// falls back to the built-in default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_agent: Option<String>,
    #[serde(default)]
    pub team_share: TeamShareConfig,
    #[serde(default)]
    pub channels: ChannelsConfig,
}

pub fn path_for(team_id: &str) -> PathBuf {
    super::layout::team_state_dir(team_id).join("team.toml")
}

pub fn active_path() -> PathBuf {
    path_for(&super::layout::active_team())
}

/// Typed load for the active team, credentials injected. Any problem is the
/// default config — a missing/broken team.toml must not take the daemon down.
pub fn load_active() -> TeamFileConfig {
    load_typed(&super::layout::active_team())
}

pub fn load_typed(team_id: &str) -> TeamFileConfig {
    match load_value(team_id) {
        Ok(value) => value.try_into().unwrap_or_default(),
        Err(_) => TeamFileConfig::default(),
    }
}

/// Fill `config`'s team-scoped fields from the active team's team.toml.
pub fn hydrate(config: &mut super::DaemonConfig) {
    let team = load_active();
    config.channels = team.channels;
    config.team_share = team.team_share;
    if let Some(agent) = team.local_agent {
        if !agent.trim().is_empty() {
            config.agents.local_agent = agent;
        }
    }
}

/// Persist the team-scoped fields of an in-memory `DaemonConfig` (the
/// channel-save sock path and the channel CLI both mutate those fields).
pub fn persist_from(config: &super::DaemonConfig) -> anyhow::Result<()> {
    let team = TeamFileConfig {
        local_agent: Some(config.agents.local_agent.clone()),
        team_share: config.team_share.clone(),
        channels: config.channels.clone(),
    };
    save_typed(&super::layout::active_team(), &team)
}

pub fn save_typed(team_id: &str, team: &TeamFileConfig) -> anyhow::Result<()> {
    let value = Value::try_from(team.clone())?;
    save_value(team_id, value)
}

/// The editable document: stripped file + secrets injected back.
pub fn load_value(team_id: &str) -> anyhow::Result<Value> {
    let path = path_for(team_id);
    let mut root = if path.exists() {
        std::fs::read_to_string(&path)?.parse::<Value>()?
    } else {
        Value::Table(Default::default())
    };
    for (key, secret) in load_secret_map(team_id) {
        set_by_path(&mut root, &key, Value::String(secret));
    }
    Ok(root)
}

/// Validate, split credentials into the secret store, write the rest 0600.
pub fn save_value(team_id: &str, mut root: Value) -> anyhow::Result<()> {
    // Strip first so validation sees exactly what will be written.
    let mut fresh: BTreeMap<String, String> = BTreeMap::new();
    if let Some(channels) = root.get_mut("channels") {
        strip_secrets("channels", channels, &mut fresh);
    }

    let _typed: TeamFileConfig = root
        .clone()
        .try_into()
        .map_err(|e| anyhow::anyhow!("validate team.toml: {e}"))?;

    // Merge: freshly provided values win; empty-on-save kept the stored value;
    // entries whose path no longer exists in the document are dropped (their
    // channel or bot was deleted).
    let previous = load_secret_map(team_id);
    let mut merged = fresh;
    for (key, secret) in previous {
        if !merged.contains_key(&key) && path_resolves(&root, &key) {
            merged.insert(key, secret);
        }
    }
    store_secret_map(team_id, merged)?;

    let path = path_for(team_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = toml::to_string_pretty(&root)?;
    std::fs::write(&path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Whether a dotted key belongs to the team document rather than daemon.toml.
/// The routing rule for the shared edit surface (`super::edit`).
pub fn is_team_key(key: &str) -> bool {
    key == "agents.local_agent"
        || key == "local_agent"
        || key == "channels"
        || key.starts_with("channels.")
        || key == "team_share"
        || key.starts_with("team_share.")
}

/// `agents.local_agent` kept its public spelling (the desktop PUTs
/// `/v1/config/agents.local_agent`); inside team.toml it is a root key.
pub fn rewrite_team_key(key: &str) -> &str {
    match key {
        "agents.local_agent" => "local_agent",
        other => other,
    }
}

// ── secret split ────────────────────────────────────────────────────────────

fn is_secret_leaf(name: &str) -> bool {
    super::edit::is_secret_key(name)
}

/// Move every non-empty secret leaf under `node` into `out`; remove secret
/// leaves from the document either way (empty string = "keep stored").
fn strip_secrets(prefix: &str, node: &mut Value, out: &mut BTreeMap<String, String>) {
    match node {
        Value::Table(table) => {
            let keys: Vec<String> = table.keys().cloned().collect();
            for key in keys {
                let child_path = format!("{prefix}.{key}");
                if is_secret_leaf(&key) {
                    if let Some(Value::String(s)) = table.get(&key) {
                        if !s.is_empty() {
                            out.insert(child_path, s.clone());
                        }
                        table.remove(&key);
                    }
                } else if let Some(child) = table.get_mut(&key) {
                    strip_secrets(&child_path, child, out);
                }
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter_mut().enumerate() {
                strip_secrets(&format!("{prefix}[{}]", element_id(item, i)), item, out);
            }
        }
        _ => {}
    }
}

/// Stable identity for an array element: its `bot_id` when it has one, else
/// the index (only id-less arrays keep the positional fragility).
fn element_id(item: &Value, index: usize) -> String {
    item.get("bot_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| index.to_string())
}

/// Split `channels.wecom.bots[b-1].secret` into segments; brackets bind to the
/// preceding segment and may contain dots.
fn split_path(key: &str) -> Vec<String> {
    let mut segs = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for c in key.chars() {
        match c {
            '[' => {
                depth += 1;
                current.push(c);
            }
            ']' => {
                depth = depth.saturating_sub(1);
                current.push(c);
            }
            '.' if depth == 0 => {
                segs.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        segs.push(current);
    }
    segs
}

fn descend<'a>(node: &'a mut Value, seg: &str) -> Option<&'a mut Value> {
    if let Some(open) = seg.find('[') {
        let (name, bracket) = seg.split_at(open);
        let id = &bracket[1..bracket.len() - 1];
        let arr = node.get_mut(name)?.as_array_mut()?;
        let index = arr
            .iter()
            .position(|item| element_id(item, usize::MAX) == id)
            .or_else(|| id.parse::<usize>().ok().filter(|i| *i < arr.len()))?;
        arr.get_mut(index)
    } else {
        node.get_mut(seg)
    }
}

fn set_by_path(root: &mut Value, key: &str, value: Value) {
    let segs = split_path(key);
    let Some((leaf, parents)) = segs.split_last() else {
        return;
    };
    let mut node = root;
    for seg in parents {
        match descend(node, seg) {
            Some(next) => node = next,
            // The channel/bot this secret belonged to is gone from the
            // document; the save-side GC will drop the entry.
            None => return,
        }
    }
    if let Value::Table(table) = node {
        table.insert(leaf.clone(), value);
    }
}

fn path_resolves(root: &Value, key: &str) -> bool {
    let segs = split_path(key);
    let Some((_leaf, parents)) = segs.split_last() else {
        return false;
    };
    // Clone-free descent needs a non-mut walker; cheapest is to walk a clone.
    let mut node = root.clone();
    let mut cursor = &mut node;
    for seg in parents {
        match descend(cursor, seg) {
            Some(next) => cursor = next,
            None => return false,
        }
    }
    true
}

// ── secret store glue ───────────────────────────────────────────────────────

fn load_secret_map(team_id: &str) -> BTreeMap<String, String> {
    crate::sync::secret_store::SecretStore::new()
        .load(team_id)
        .map(|s| s.channel_secrets)
        .unwrap_or_default()
}

fn store_secret_map(team_id: &str, map: BTreeMap<String, String>) -> anyhow::Result<()> {
    let store = crate::sync::secret_store::SecretStore::new();
    let mut secrets = store.load(team_id).unwrap_or_default();
    if secrets.channel_secrets == map {
        return Ok(());
    }
    secrets.channel_secrets = map;
    store
        .save(team_id, &secrets)
        .map_err(|e| anyhow::anyhow!("store channel secrets: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_brand_env::BrandEnvGuard;

    fn doc(text: &str) -> Value {
        text.parse().unwrap()
    }

    #[test]
    fn save_strips_credentials_and_load_injects_them() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc(r#"
[channels.discord]
enabled = true
bot_token = "tok-123"

[channels.wecom]
enabled = true

[[channels.wecom.bots]]
bot_id = "b-1"
secret = "s-1"

[[channels.wecom.bots]]
bot_id = "b-2"
secret = "s-2"
"#),
        )
        .unwrap();

        let written = std::fs::read_to_string(path_for("team-1")).unwrap();
        assert!(!written.contains("tok-123"), "{written}");
        assert!(!written.contains("s-1"), "{written}");
        assert!(written.contains("bot_id"), "{written}");

        let loaded = load_typed("team-1");
        let discord = loaded.channels.discord.unwrap();
        assert_eq!(discord.bot_token, "tok-123");
        let wecom = loaded.channels.wecom.unwrap();
        assert_eq!(wecom.bots[0].secret, "s-1");
        assert_eq!(wecom.bots[1].secret, "s-2");
    }

    /// Deleting bot 0 must not hand bot 1 someone else's secret, and must drop
    /// the deleted bot's stored credential.
    #[test]
    fn secrets_follow_bot_ids_not_indices() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc(r#"
[channels.wecom]
enabled = true
[[channels.wecom.bots]]
bot_id = "b-1"
secret = "s-1"
[[channels.wecom.bots]]
bot_id = "b-2"
secret = "s-2"
"#),
        )
        .unwrap();

        // Re-save with b-1 deleted and b-2's secret left empty ("keep").
        save_value(
            "team-1",
            doc(r#"
[channels.wecom]
enabled = true
[[channels.wecom.bots]]
bot_id = "b-2"
secret = ""
"#),
        )
        .unwrap();

        let loaded = load_typed("team-1");
        let bots = loaded.channels.wecom.unwrap().bots;
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].secret, "s-2", "b-2 keeps its own secret");
        assert!(
            !load_secret_map("team-1").contains_key("channels.wecom.bots[b-1].secret"),
            "the deleted bot's secret must be garbage-collected"
        );
    }

    #[test]
    fn empty_secret_on_save_keeps_the_stored_value() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc("[channels.kook]\nenabled = true\nbot_token = \"kk-1\"\n"),
        )
        .unwrap();
        save_value(
            "team-1",
            doc("[channels.kook]\nenabled = false\nbot_token = \"\"\n"),
        )
        .unwrap();

        let loaded = load_typed("team-1");
        let kook = loaded.channels.kook.unwrap();
        assert!(!kook.enabled);
        assert_eq!(kook.bot_token, "kk-1");
    }

    #[test]
    fn hydrate_fills_daemon_config_and_persist_round_trips() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        let mut config = super::super::DaemonConfig::bootstrap();
        config.agents.local_agent = "pi".into();
        config.team_share.auto_sync = false;
        config.channels.discord = Some(super::super::DiscordChannel {
            enabled: true,
            bot_token: "tok".into(),
            default_username: None,
        });
        persist_from(&config).unwrap();

        let mut fresh = super::super::DaemonConfig::bootstrap();
        hydrate(&mut fresh);
        assert_eq!(fresh.agents.local_agent, "pi");
        assert!(!fresh.team_share.auto_sync);
        assert_eq!(fresh.channels.discord.unwrap().bot_token, "tok");
    }

    #[test]
    fn team_keys_route_to_the_team_document() {
        for key in [
            "channels",
            "channels.wecom.bots.0.secret",
            "team_share.auto_sync",
            "agents.local_agent",
        ] {
            assert!(is_team_key(key), "{key}");
        }
        for key in ["mqtt.broker_url", "agents.opencode.binary", "actor.name"] {
            assert!(!is_team_key(key), "{key}");
        }
        assert_eq!(rewrite_team_key("agents.local_agent"), "local_agent");
    }
}
