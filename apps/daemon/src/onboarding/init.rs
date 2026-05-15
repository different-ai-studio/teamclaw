use crate::config::{AgentsConfig, DaemonConfig, DeviceConfig, MqttConfig};
use crate::onboarding::invite_url::{self, ParsedInvite};
use crate::supabase::error::{SupabaseError, SupabaseResult};
use crate::supabase::{SupabaseClient, SupabaseConfig};
use std::path::{Path, PathBuf};

const DEFAULT_MQTT_BROKER_URL: &str = "mqtts://ai.ucar.cc:8883";

pub struct InitOutcome {
    pub actor_id: String,
    pub team_id: String,
    pub display_name: String,
    pub config_path: PathBuf,
}

/// Execute `amuxd init <amux://invite?token=...>`:
///  1. parse token
///  2. anon-RPC `claim_team_invite` → mint daemon auth.users + refresh_token
///  3. verify by trading refresh_token for an access_token
///  4. persist `supabase.toml`
///  5. write `daemon.toml` with the shared-broker defaults if absent, or
///     preserve the existing one's device.id while refreshing team_id
pub async fn run(raw_url: &str, config_path: Option<&Path>) -> SupabaseResult<InitOutcome> {
    let invite = invite_url::parse(raw_url)?;

    let base_cfg = supabase_build_env_config_from_process()?;
    let claim_client = SupabaseClient::new(base_cfg.clone())?;
    let claim = claim_client.claim_team_invite(&invite.token).await?;

    let refresh_token =
        claim
            .refresh_token
            .clone()
            .ok_or_else(|| crate::supabase::error::SupabaseError::Rpc {
                code: None,
                message: "claim_team_invite did not return a refresh token (kind=member?)".into(),
            })?;

    let cfg = SupabaseConfig {
        url: base_cfg.url,
        anon_key: base_cfg.anon_key,
        refresh_token,
        team_id: claim.team_id.clone(),
        actor_id: claim.actor_id.clone(),
    };

    let verify_client = SupabaseClient::new(cfg.clone())?;
    verify_client.access_token().await?;

    let path = match config_path {
        Some(p) => p.to_path_buf(),
        None => SupabaseConfig::default_path()?,
    };
    cfg.save(&path)?;

    let daemon_path = DaemonConfig::default_path();
    let existing_daemon_cfg = DaemonConfig::load(&daemon_path).ok();
    let daemon_cfg = daemon_config_for_invite(
        existing_daemon_cfg,
        &claim.display_name,
        &claim.team_id,
        &claim.actor_id,
        &invite,
    );
    daemon_cfg.save(&daemon_path).map_err(|e| {
        crate::supabase::error::SupabaseError::Config(format!("write daemon.toml: {e}"))
    })?;

    Ok(InitOutcome {
        actor_id: claim.actor_id,
        team_id: claim.team_id,
        display_name: claim.display_name,
        config_path: path,
    })
}

fn default_daemon_config(display_name: &str, actor_id: &str) -> DaemonConfig {
    DaemonConfig {
        device: DeviceConfig {
            id: actor_id.to_string(),
            name: display_name.to_string(),
        },
        mqtt: MqttConfig {
            broker_url: DEFAULT_MQTT_BROKER_URL.to_string(),
        },
        agents: AgentsConfig::default(),
        team_id: None,
    }
}

fn supabase_build_env_config_from_process() -> SupabaseResult<SupabaseConfig> {
    let url = std::env::var("SUPABASE_URL").ok();
    let anon_key = std::env::var("SUPABASE_ANON_KEY").ok();
    supabase_build_env_config(url.as_deref(), anon_key.as_deref())
}

fn supabase_build_env_config(
    url: Option<&str>,
    anon_key: Option<&str>,
) -> SupabaseResult<SupabaseConfig> {
    let url = required_supabase_env("SUPABASE_URL", url)?;
    let anon_key = required_supabase_env("SUPABASE_ANON_KEY", anon_key)?;

    Ok(SupabaseConfig {
        url,
        anon_key,
        refresh_token: String::new(),
        team_id: String::new(),
        actor_id: String::new(),
    })
}

fn required_supabase_env(name: &str, value: Option<&str>) -> SupabaseResult<String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    value
        .map(str::to_string)
        .ok_or_else(|| SupabaseError::Config(format!("{name} env var required for `amuxd init`")))
}

fn daemon_config_for_invite(
    existing: Option<DaemonConfig>,
    display_name: &str,
    team_id: &str,
    actor_id: &str,
    invite: &ParsedInvite,
) -> DaemonConfig {
    let mut daemon_cfg = existing.unwrap_or_else(|| default_daemon_config(display_name, actor_id));
    // device.id must equal actor_id — the Supabase access-token hook embeds
    // ACL rules under `amux/{team}/device/{actor_id}/...`, so any other
    // value makes EMQX reject the daemon's CONNECT (LWT topic denied).
    daemon_cfg.device.id = actor_id.to_string();
    daemon_cfg.team_id = Some(team_id.to_string());
    daemon_cfg.mqtt.broker_url = invite
        .broker_url
        .clone()
        .unwrap_or_else(|| DEFAULT_MQTT_BROKER_URL.to_string());
    daemon_cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_broker_url_overrides_default() {
        let cfg = daemon_config_for_invite(
            None,
            "macmini-5",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: Some("mqtts://broker.example.com:8883".into()),
            },
        );
        assert_eq!(cfg.team_id.as_deref(), Some("team-1"));
        assert_eq!(cfg.device.id, "actor-1");
        assert_eq!(cfg.device.name, "macmini-5");
        assert_eq!(cfg.mqtt.broker_url, "mqtts://broker.example.com:8883");
    }

    #[test]
    fn legacy_invite_uses_default_broker_url() {
        let cfg = daemon_config_for_invite(
            None,
            "macmini-5",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
            },
        );
        assert_eq!(cfg.mqtt.broker_url, DEFAULT_MQTT_BROKER_URL);
    }

    #[test]
    fn existing_device_id_is_replaced_with_actor_id() {
        // device.id MUST equal actor_id — EMQX rejects any other value
        // because the JWT ACL is keyed on actor_id. Re-init with a
        // different actor must overwrite a stale device.id.
        let cfg = daemon_config_for_invite(
            Some(DaemonConfig {
                device: DeviceConfig {
                    id: "stale-device-uuid".into(),
                    name: "existing-device".into(),
                },
                mqtt: MqttConfig {
                    broker_url: "mqtts://old.example.com:8883".into(),
                },
                agents: AgentsConfig::default(),
                team_id: Some("team-old".into()),
            }),
            "new-display-name",
            "team-2",
            "actor-2",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: Some("mqtts://broker.example.com:8883".into()),
            },
        );
        assert_eq!(cfg.device.id, "actor-2");
        assert_eq!(cfg.device.name, "existing-device");
        assert_eq!(cfg.team_id.as_deref(), Some("team-2"));
        assert_eq!(cfg.mqtt.broker_url, "mqtts://broker.example.com:8883");
    }

    #[test]
    fn supabase_build_env_reports_missing_url_at_runtime() {
        let err = supabase_build_env_config(None, Some("anon")).unwrap_err();
        assert!(err.to_string().contains("SUPABASE_URL"));
    }

    #[test]
    fn supabase_build_env_reports_missing_anon_key_at_runtime() {
        let err = supabase_build_env_config(Some("https://example.supabase.co"), None).unwrap_err();
        assert!(err.to_string().contains("SUPABASE_ANON_KEY"));
    }

    #[test]
    fn supabase_build_env_uses_supplied_values() {
        let cfg = supabase_build_env_config(Some("https://example.supabase.co"), Some("anon-key"))
            .unwrap();

        assert_eq!(cfg.url, "https://example.supabase.co");
        assert_eq!(cfg.anon_key, "anon-key");
        assert!(cfg.refresh_token.is_empty());
        assert!(cfg.team_id.is_empty());
        assert!(cfg.actor_id.is_empty());
    }
}
