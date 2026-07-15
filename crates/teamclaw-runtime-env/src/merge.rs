use std::collections::HashMap;

use crate::SystemEnvContext;

pub fn merge_env_maps(
    personal: HashMap<String, String>,
    team: HashMap<String, String>,
    system: &SystemEnvContext,
) -> HashMap<String, String> {
    let mut merged = personal;
    merged.extend(team);

    if !system.actor_id.is_empty() {
        merged.insert("actor_id".to_string(), system.actor_id.clone());
        let suffix: String = system.actor_id.chars().take(40).collect();
        merged.insert("tc_api_key".to_string(), format!("sk-tc-{suffix}"));
    }
    if !system.display_name.is_empty() {
        merged.insert("display_name".to_string(), system.display_name.clone());
    }
    if let Some(path) = system
        .cloud_token_file
        .as_deref()
        .filter(|p| !p.is_empty())
    {
        merged.insert("TC_ACCESS_TOKEN_FILE".to_string(), path.to_string());
    }

    normalize_env_map(merged)
}

/// Uppercase and dot-free aliases (daemon `normalize_env_map` + desktop OpenCode sidecar).
fn normalize_env_map(input: HashMap<String, String>) -> HashMap<String, String> {
    let mut out = input;

    let upper_additions: Vec<(String, String)> = out
        .iter()
        .filter_map(|(key, value)| {
            let upper = key.to_ascii_uppercase();
            if key == &upper || out.contains_key(&upper) {
                None
            } else {
                Some((upper, value.clone()))
            }
        })
        .collect();
    for (key, value) in upper_additions {
        out.insert(key, value);
    }

    let dot_additions: Vec<(String, String)> = out
        .iter()
        .filter_map(|(key, value)| {
            if !key.contains('.') {
                return None;
            }
            let alias = key.replace('.', "_");
            if out.contains_key(&alias) {
                None
            } else {
                Some((alias, value.clone()))
            }
        })
        .collect();
    for (key, value) in dot_additions {
        out.insert(key, value);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(actor_id: &str, display_name: &str) -> SystemEnvContext {
        SystemEnvContext {
            actor_id: actor_id.to_string(),
            display_name: display_name.to_string(),
            cloud_token_file: None,
        }
    }

    #[test]
    fn team_overrides_personal_on_duplicate() {
        let mut personal = HashMap::new();
        personal.insert("FOO".to_string(), "personal".to_string());
        let mut team = HashMap::new();
        team.insert("FOO".to_string(), "team".to_string());

        let out = merge_env_maps(personal, team, &ctx("", ""));

        assert_eq!(out.get("FOO").map(String::as_str), Some("team"));
    }

    #[test]
    fn tc_api_key_from_actor_id() {
        let actor_id = "a".repeat(50);
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx(&actor_id, ""));

        assert_eq!(out.get("actor_id").map(String::as_str), Some(actor_id.as_str()));
        let expected_key = format!("sk-tc-{}", &actor_id[..40]);
        assert_eq!(out.get("tc_api_key").map(String::as_str), Some(expected_key.as_str()));
    }

    #[test]
    fn injects_cloud_token_file_when_set() {
        let mut ctx = ctx("actor-1", "host");
        ctx.cloud_token_file = Some("/home/u/.amuxd/amuxd.cloud-token".to_string());

        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx);

        assert_eq!(
            out.get("TC_ACCESS_TOKEN_FILE").map(String::as_str),
            Some("/home/u/.amuxd/amuxd.cloud-token")
        );
    }

    #[test]
    fn skips_cloud_token_file_when_none_or_empty() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("actor-1", ""));
        assert!(!out.contains_key("TC_ACCESS_TOKEN_FILE"));

        let mut ctx = ctx("actor-1", "");
        ctx.cloud_token_file = Some(String::new());
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx);
        assert!(!out.contains_key("TC_ACCESS_TOKEN_FILE"));
    }

    #[test]
    fn skips_tc_api_key_when_actor_id_empty() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("", "host"));

        assert!(!out.contains_key("actor_id"));
        assert!(!out.contains_key("tc_api_key"));
        assert_eq!(out.get("display_name").map(String::as_str), Some("host"));
    }

    #[test]
    fn injects_actor_id_and_display_name() {
        let out = merge_env_maps(
            HashMap::new(),
            HashMap::new(),
            &ctx("actor-123", "My Mac"),
        );

        assert_eq!(out.get("actor_id").map(String::as_str), Some("actor-123"));
        assert_eq!(out.get("display_name").map(String::as_str), Some("My Mac"));
        assert_eq!(out.get("tc_api_key").map(String::as_str), Some("sk-tc-actor-123"));
    }

    #[test]
    fn adds_uppercase_alias_for_lowercase_key() {
        let mut personal = HashMap::new();
        personal.insert("tc_api_key".to_string(), "secret".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("tc_api_key").map(String::as_str), Some("secret"));
        assert_eq!(out.get("TC_API_KEY").map(String::as_str), Some("secret"));
    }

    #[test]
    fn adds_dot_free_alias_for_dotted_key() {
        let mut personal = HashMap::new();
        personal.insert("wecom.corp_id".to_string(), "cid".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("wecom.corp_id").map(String::as_str), Some("cid"));
        assert_eq!(out.get("wecom_corp_id").map(String::as_str), Some("cid"));
    }
}
