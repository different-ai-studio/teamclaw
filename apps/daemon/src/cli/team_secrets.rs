//! `amuxd team secrets` — provision team-share credentials on a daemon that has
//! no desktop app to push them over `POST /v1/team/secrets`.
//!
//! Writes the same store the HTTP path does (`~/.amuxd/team-secrets/<id>.enc`),
//! offline: the daemon need not be running, and a running daemon picks the
//! secrets up on its next sync tick without a reload signal.

use std::io::Write;
use std::path::PathBuf;

use crate::config::DaemonConfig;
use crate::sync::secret_store::{validate_oss_secret, SecretStore, TeamSecrets};

use super::{TeamAction, TeamArgs, TeamSecretsAction};

pub fn run(args: TeamArgs) -> anyhow::Result<()> {
    let TeamAction::Secrets(secrets) = args.action;
    match secrets.action {
        TeamSecretsAction::Set {
            team_id,
            oss_secret,
            git_credential,
            git_credential_file,
            git_branch,
        } => set(
            team_id,
            oss_secret,
            git_credential,
            git_credential_file,
            git_branch,
        ),
        TeamSecretsAction::Show { team_id } => show(team_id),
        TeamSecretsAction::Clear { team_id, force } => clear(team_id, force),
    }
}

/// The team this daemon is bound to. `amuxd init` writes it; the daemon is
/// single-team, so an explicit `--team-id` is only for unusual cases.
fn resolve_team_id(explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(id) = explicit {
        let id = id.trim().to_string();
        if id.is_empty() {
            anyhow::bail!("--team-id is empty");
        }
        return Ok(id);
    }
    let path = DaemonConfig::default_path();
    let config = DaemonConfig::load(&path).map_err(|e| {
        anyhow::anyhow!(
            "read {}: {e}\nRun `amuxd init <teamclaw://invite?token=...>` first, or pass --team-id.",
            path.display()
        )
    })?;
    config
        .team_id
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no team_id in {}.\nRun `amuxd init <teamclaw://invite?token=...>` first, or pass --team-id.",
                path.display()
            )
        })
}

fn set(
    team_id: Option<String>,
    oss_secret: Option<String>,
    git_credential: Option<String>,
    git_credential_file: Option<PathBuf>,
    git_branch: Option<String>,
) -> anyhow::Result<()> {
    let team_id = resolve_team_id(team_id)?;

    let git_credential = match (git_credential, git_credential_file) {
        (Some(c), _) => Some(c),
        // Trailing newlines are near-universal in key files and would corrupt
        // an SSH PEM or an https `user:token` pair.
        (None, Some(path)) => Some(
            std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?
                .trim_end()
                .to_string(),
        ),
        (None, None) => None,
    };

    let oss_secret = oss_secret.map(|s| s.trim().to_string());
    if let Some(s) = &oss_secret {
        validate_oss_secret(s).map_err(|e| anyhow::anyhow!("--oss-secret: {e}"))?;
    }

    if oss_secret.is_none() && git_credential.is_none() && git_branch.is_none() {
        anyhow::bail!(
            "nothing to set: pass --oss-secret, --git-credential/--git-credential-file, or --git-branch"
        );
    }

    let incoming = TeamSecrets {
        oss_team_secret: oss_secret,
        // The daemon self-supplies its own cloud bearer for OSS sync, so this
        // field is intentionally not settable here.
        user_jwt: None,
        git_credential,
        git_branch,
    };

    let store = SecretStore::new();
    store
        .merge(&team_id, &incoming)
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    println!("✓ secrets updated for team {team_id}");
    print_state(&store, &team_id)?;
    println!("\nRestart the daemon (`amuxd stop && amuxd start`) so the sync timer picks up this team's workspaces.");
    Ok(())
}

fn show(team_id: Option<String>) -> anyhow::Result<()> {
    let team_id = resolve_team_id(team_id)?;
    let store = SecretStore::new();
    println!("team {team_id}");
    print_state(&store, &team_id)
}

fn print_state(store: &SecretStore, team_id: &str) -> anyhow::Result<()> {
    let s = store.load(team_id).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("  oss_team_secret = {}", mask(s.oss_team_secret.as_deref()));
    println!("  git_credential  = {}", mask(s.git_credential.as_deref()));
    println!(
        "  git_branch      = {}",
        s.git_branch.as_deref().unwrap_or("(unset)")
    );
    Ok(())
}

use crate::sync::secret_store::mask_secret as mask;

fn clear(team_id: Option<String>, force: bool) -> anyhow::Result<()> {
    let team_id = resolve_team_id(team_id)?;
    let store = SecretStore::new();

    if !force {
        print!("Remove all stored secrets for team {team_id}? [y/N]: ");
        std::io::stdout().flush()?;
        let mut buf = String::new();
        std::io::stdin().read_line(&mut buf)?;
        let answer = buf.trim().to_lowercase();
        if answer != "y" && answer != "yes" {
            println!("Aborted.");
            return Ok(());
        }
    }

    store.clear(&team_id).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("✓ secrets cleared for team {team_id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oss_secret_must_be_64_hex() {
        assert!(validate_oss_secret(&"ab".repeat(32)).is_ok());
        assert!(validate_oss_secret(&"AB".repeat(32)).is_ok());
        // Too short, and the length is what a user is most likely to get wrong.
        assert!(validate_oss_secret("abcd").is_err());
        // Right length, but 'z' is not hex — would fail at HKDF decode.
        assert!(validate_oss_secret(&"z".repeat(64)).is_err());
    }

    #[test]
    fn mask_reveals_only_the_edges() {
        assert_eq!(mask(None), "(unset)");
        // A short value has no safe middle to elide.
        assert_eq!(mask(Some("short")), "(set)");
        assert_eq!(mask(Some("0123456789abcdef")), "(set, 0123…cdef)");
    }

    #[test]
    fn explicit_team_id_wins_and_rejects_blank() {
        assert_eq!(resolve_team_id(Some("t-1".into())).unwrap(), "t-1");
        assert!(resolve_team_id(Some("   ".into())).is_err());
    }
}
