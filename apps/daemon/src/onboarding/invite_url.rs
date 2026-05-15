use crate::supabase::error::{SupabaseError, SupabaseResult};
use url::Url;

/// Parsed representation of an `amux://invite?token=<opaque>` deeplink.
pub struct ParsedInvite {
    pub token: String,
    pub broker_url: Option<String>,
}

pub fn parse(raw: &str) -> SupabaseResult<ParsedInvite> {
    let url =
        Url::parse(raw).map_err(|e| SupabaseError::Config(format!("parse invite url: {e}")))?;

    if url.scheme() != "amux" {
        return Err(SupabaseError::Config(format!(
            "invite url scheme must be 'amux', got {}",
            url.scheme()
        )));
    }
    if url.host_str() != Some("invite") {
        return Err(SupabaseError::Config(format!(
            "invite url host must be 'invite', got {:?}",
            url.host_str()
        )));
    }

    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| SupabaseError::Config("invite url missing 'token'".into()))?;
    if token.is_empty() {
        return Err(SupabaseError::Config("invite token is empty".into()));
    }

    let broker_url = url
        .query_pairs()
        .find(|(k, _)| k == "broker")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty());

    Ok(ParsedInvite { token, broker_url })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_invite_url() {
        let p = parse("amux://invite?token=ABCDEF-12345_xyz").unwrap();
        assert_eq!(p.token, "ABCDEF-12345_xyz");
        assert_eq!(p.broker_url, None);
    }

    #[test]
    fn parses_invite_with_broker_url() {
        let p = parse("amux://invite?token=tok-123&broker=mqtts://ai.ucar.cc:8883").unwrap();
        assert_eq!(p.token, "tok-123");
        assert_eq!(p.broker_url.as_deref(), Some("mqtts://ai.ucar.cc:8883"));
    }

    #[test]
    fn ignores_legacy_username_password_params() {
        let p = parse(
            "amux://invite?token=tok-123&broker=mqtts://ai.ucar.cc:8883&username=teamclaw&password=teamclaw2026",
        )
        .unwrap();
        assert_eq!(p.token, "tok-123");
        assert_eq!(p.broker_url.as_deref(), Some("mqtts://ai.ucar.cc:8883"));
    }

    #[test]
    fn rejects_wrong_scheme() {
        assert!(parse("http://invite?token=x").is_err());
    }

    #[test]
    fn rejects_wrong_host() {
        assert!(parse("amux://join?token=x").is_err());
    }

    #[test]
    fn rejects_missing_token() {
        assert!(parse("amux://invite").is_err());
    }

    #[test]
    fn rejects_empty_token() {
        assert!(parse("amux://invite?token=").is_err());
    }
}
