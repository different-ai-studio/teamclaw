//! pi coding-agent discovery + install for amuxd (parity with `opencode_install`).
//!
//! `pi.lock.json` records the MINIMUM pi version this build requires. pi is
//! installed via npm (`npm install -g @earendil-works/pi`, bun fallback); its
//! own installer places a launcher at `~/.pi/bin/pi`, which amuxd resolves by
//! absolute path so background services find it without a login PATH.

use serde::{Deserialize, Serialize};

use crate::opencode_install::{parse_semver, version_ge};

#[derive(Debug, Deserialize)]
pub struct PiLock {
    pub version: String,
}

/// Embedded at compile time from apps/daemon/pi.lock.json
pub const LOCK_JSON: &str = include_str!("../../pi.lock.json");

/// The minimum pi version this build requires (lock version, no leading `v`).
pub fn required_version() -> String {
    serde_json::from_str::<PiLock>(LOCK_JSON)
        .map(|l| l.version.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// Resolve the pi binary amuxd should run. Order: explicit daemon config
/// override (`agents.pi.binary`) → `~/.pi/bin/pi` → `pi` on PATH.
pub fn resolve_binary(configured: Option<&str>) -> String {
    crate::runtime::pi_rpc::process::resolve_binary(configured)
}

/// `<bin> --version` → the first version-like token.
fn pi_version_of(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next().unwrap_or("").trim();
    line.split_whitespace()
        .find(|tok| parse_semver(tok).is_some())
        .map(|t| t.to_string())
        .or_else(|| (!line.is_empty()).then(|| line.to_string()))
}

/// Detect the pi amuxd would run + its reported version.
pub fn detect_pi() -> Option<(String, String)> {
    let bin = resolve_binary(None);
    let version = pi_version_of(&bin)?;
    Some((bin, version))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub required_version: String,
    pub satisfied: bool,
}

pub fn doctor() -> PiStatus {
    let want = required_version();
    let detected = detect_pi();
    let (present, version, path) = match &detected {
        Some((p, v)) => (true, Some(v.clone()), Some(p.clone())),
        None => (false, None, None),
    };
    let satisfied = version
        .as_deref()
        .map(|v| version_ge(v, &want))
        .unwrap_or(false);
    PiStatus {
        present,
        version,
        path,
        required_version: want,
        satisfied,
    }
}

fn progress(event: &str, message: &str) {
    println!(
        "{}",
        serde_json::json!({ "event": event, "message": message })
    );
}

fn has_command(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Install or upgrade pi via `npm install -g @earendil-works/pi`
/// (falls back to `bun add -g` when npm is absent).
pub fn run_install(force: bool) -> anyhow::Result<()> {
    let want = required_version();

    if !force {
        if let Some((path, have)) = detect_pi() {
            if version_ge(&have, &want) {
                progress(
                    "ok",
                    &format!("pi {have} already satisfies >= {want} ({path})"),
                );
                return Ok(());
            }
            progress(
                "upgrade",
                &format!("pi {have} is older than required {want}; upgrading"),
            );
        } else {
            progress("install", &format!("installing pi (require >= {want})"));
        }
    }

    let (cmd, args): (&str, Vec<&str>) = if has_command("npm") {
        ("npm", vec!["install", "-g", "@earendil-works/pi"])
    } else if has_command("bun") {
        ("bun", vec!["add", "-g", "@earendil-works/pi"])
    } else {
        anyhow::bail!("neither npm nor bun found; install Node.js or Bun first");
    };

    progress("install", &format!("running {cmd} {}", args.join(" ")));
    let output = std::process::Command::new(cmd)
        .args(&args)
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run {cmd}: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stdout.is_empty() {
        progress("output", &stdout);
    }
    if !output.status.success() {
        anyhow::bail!(
            "pi install failed ({}): {}",
            output.status,
            if stderr.is_empty() { stdout } else { stderr }
        );
    }
    progress("ok", &format!("pi installed/upgraded (require >= {want})"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_parses_and_pins_0_81_1_minimum() {
        let v = required_version();
        assert!(!v.starts_with('v'), "got {v}");
        assert!(version_ge(&v, "0.81.1"), "lock too old: {v}");
    }

    #[test]
    fn pi_status_serializes_camel_case() {
        let s = PiStatus {
            present: true,
            version: Some("0.81.1".into()),
            path: Some("/x/pi".into()),
            required_version: "0.81.1".into(),
            satisfied: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["requiredVersion"], serde_json::json!("0.81.1"));
        assert_eq!(v["satisfied"], serde_json::json!(true));
    }
}
