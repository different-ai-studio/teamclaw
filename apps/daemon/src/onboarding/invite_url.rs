use anyhow::{anyhow, Result};
use url::Url;

const LEGACY_INVITE_SCHEMES: &[&str] = &["teamclaw", "amux"];

const BLOCKED_INVITE_SCHEMES: &[&str] = &[
    "http",
    "https",
    "ftp",
    "file",
    "mailto",
    "ws",
    "wss",
    "javascript",
    "data",
];

/// Parsed representation of a `teamclaw://invite?token=<opaque>` deeplink.
pub struct ParsedInvite {
    pub token: String,
    pub broker_url: Option<String>,
    /// Optional `?cloud_api_url=` override. The inviter (desktop) bakes its own
    /// effective Cloud API endpoint into the invite so the daemon follows the
    /// app's build/runtime choice instead of a hardcoded default.
    pub cloud_api_url: Option<String>,
}

fn is_custom_app_scheme(scheme: &str) -> bool {
    if BLOCKED_INVITE_SCHEMES.contains(&scheme) {
        return false;
    }
    let mut chars = scheme.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
}

fn is_accepted_invite_scheme(scheme: &str) -> bool {
    LEGACY_INVITE_SCHEMES.contains(&scheme) || is_custom_app_scheme(scheme)
}

pub fn parse(raw: &str) -> Result<ParsedInvite> {
    let url = Url::parse(raw).map_err(|e| anyhow!("parse invite url: {e}"))?;

    if !is_accepted_invite_scheme(url.scheme()) {
        return Err(anyhow!(
            "invite url scheme must be a TeamClaw app scheme (e.g. teamclaw, teamclaw-dev), got {}",
            url.scheme()
        ));
    }
    if url.host_str() != Some("invite") {
        return Err(anyhow!(
            "invite url host must be 'invite', got {:?}",
            url.host_str()
        ));
    }

    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| anyhow!("invite url missing 'token'"))?;
    if token.is_empty() {
        return Err(anyhow!("invite token is empty"));
    }

    let broker_url = url
        .query_pairs()
        .find(|(k, _)| k == "broker")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty());

    let cloud_api_url = url
        .query_pairs()
        .find(|(k, _)| k == "cloud_api_url")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty());

    Ok(ParsedInvite {
        token,
        broker_url,
        cloud_api_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_invite_url() {
        let p = parse("teamclaw://invite?token=ABCDEF-12345_xyz").unwrap();
        assert_eq!(p.token, "ABCDEF-12345_xyz");
        assert_eq!(p.broker_url, None);
    }

    #[test]
    fn parses_legacy_amux_invite_url() {
        let p = parse("amux://invite?token=ABCDEF-12345_xyz").unwrap();
        assert_eq!(p.token, "ABCDEF-12345_xyz");
        assert_eq!(p.broker_url, None);
    }

    #[test]
    fn parses_invite_with_broker_url() {
        let p = parse("teamclaw://invite?token=tok-123&broker=mqtts://ai.ucar.cc:8883").unwrap();
        assert_eq!(p.token, "tok-123");
        assert_eq!(p.broker_url.as_deref(), Some("mqtts://ai.ucar.cc:8883"));
        assert_eq!(p.cloud_api_url, None);
    }

    #[test]
    fn parses_invite_with_cloud_api_url() {
        // The desktop URL-encodes its effective endpoint into `?cloud_api_url=`.
        let p = parse(
            "teamclaw://invite?token=tok-123&cloud_api_url=https%3A%2F%2Flegacy-test-api.example.test",
        )
        .unwrap();
        assert_eq!(p.token, "tok-123");
        assert_eq!(
            p.cloud_api_url.as_deref(),
            Some("https://legacy-test-api.example.test")
        );
    }

    #[test]
    fn empty_cloud_api_url_is_none() {
        let p = parse("teamclaw://invite?token=tok-123&cloud_api_url=").unwrap();
        assert_eq!(p.cloud_api_url, None);
    }

    #[test]
    fn ignores_legacy_username_password_params() {
        let p = parse(
            "teamclaw://invite?token=tok-123&broker=mqtts://ai.ucar.cc:8883&username=teamclaw&password=teamclaw2026",
        )
        .unwrap();
        assert_eq!(p.token, "tok-123");
        assert_eq!(p.broker_url.as_deref(), Some("mqtts://ai.ucar.cc:8883"));
    }

    #[test]
    fn parses_dev_invite_url() {
        let p = parse("teamclaw-dev://invite?token=ABCDEF-12345_xyz").unwrap();
        assert_eq!(p.token, "ABCDEF-12345_xyz");
        assert_eq!(p.broker_url, None);
    }

    #[test]
    fn rejects_wrong_scheme() {
        match parse("http://invite?token=x") {
            Ok(_) => panic!("expected wrong scheme to be rejected"),
            Err(err) => assert!(
                err.to_string().contains("TeamClaw app scheme"),
                "got: {err}"
            ),
        }
    }

    #[test]
    fn rejects_wrong_host() {
        assert!(parse("teamclaw://join?token=x").is_err());
    }

    #[test]
    fn rejects_missing_token() {
        assert!(parse("teamclaw://invite").is_err());
    }

    #[test]
    fn rejects_empty_token() {
        assert!(parse("teamclaw://invite?token=").is_err());
    }
}
