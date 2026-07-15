/// Map a session binding URI to a `(channel, default_target)` pair. The
/// channel scheme determines the platform; the rest of the URI determines
/// the per-platform target shape used by `ChannelManager::dispatch_send`
/// (`user:<id>` or `chat:<id>`).
///
/// Binding shapes (from `crates/teamclaw-gateway/src/binding.rs`):
///   wecom://{corp_id}/{agent_id}/single/{userid}
///   wecom://{corp_id}/{agent_id}/external-single/{ext_userid}
///   wecom://{corp_id}/{agent_id}/group/{chat_id}
///   feishu://{app_id}/{chat_id}
///   discord://{application_id}/{channel_id}
///   kook://{scope}/{channel_id}
///   wechat://{ilink_account}/single/{from_user_id}
///   email://{account_key}/thread/{thread_key}
///
/// Only WeCom defaults are wired today; other channels return
/// `Ok((channel, None))` so the agent can still send by providing an explicit
/// target override even before per-channel dispatch lands.
pub(crate) fn parse_binding_to_target(
    binding: &str,
) -> anyhow::Result<(&'static str, Option<String>)> {
    let (scheme, rest) = binding
        .split_once("://")
        .ok_or_else(|| anyhow::anyhow!("binding missing scheme: {binding}"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    match scheme {
        "wecom" => {
            if parts.len() < 4 {
                anyhow::bail!("wecom binding malformed: {binding}");
            }
            let kind = parts[2];
            let id = parts[3];
            let target = match kind {
                "single" | "external-single" => format!("user:{id}"),
                "group" => format!("chat:{id}"),
                other => anyhow::bail!("unknown wecom binding kind: {other}"),
            };
            Ok(("wecom", Some(target)))
        }
        "feishu" => Ok(("feishu", None)),
        "discord" => Ok(("discord", None)),
        "kook" => Ok(("kook", None)),
        "wechat" => Ok(("wechat", None)),
        "email" => Ok(("email", None)),
        other => anyhow::bail!("unknown binding scheme: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wecom_single_maps_to_user_target() {
        let (channel, target) =
            parse_binding_to_target("wecom://corp/agent/single/user-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target.as_deref(), Some("user:user-1"));
    }

    #[test]
    fn wecom_external_single_maps_to_user_target() {
        let (channel, target) =
            parse_binding_to_target("wecom://corp/agent/external-single/ext-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target.as_deref(), Some("user:ext-1"));
    }

    #[test]
    fn wecom_group_maps_to_chat_target() {
        let (channel, target) = parse_binding_to_target("wecom://corp/agent/group/chat-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target.as_deref(), Some("chat:chat-1"));
    }

    #[test]
    fn non_wecom_binding_has_channel_but_no_default_target() {
        let (channel, target) = parse_binding_to_target("feishu://app/chat-1").unwrap();
        assert_eq!(channel, "feishu");
        assert!(target.is_none());
    }

    #[test]
    fn rejects_binding_without_scheme() {
        let err = parse_binding_to_target("not-a-binding").unwrap_err();
        assert!(err.to_string().contains("missing scheme"), "got: {err}");
    }

    #[test]
    fn rejects_malformed_wecom_binding() {
        let err = parse_binding_to_target("wecom://corp/agent/single").unwrap_err();
        assert!(err.to_string().contains("malformed"), "got: {err}");
    }

    #[test]
    fn rejects_unknown_wecom_kind() {
        let err = parse_binding_to_target("wecom://corp/agent/channel/id").unwrap_err();
        assert!(
            err.to_string().contains("unknown wecom binding kind"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_unknown_scheme() {
        let err = parse_binding_to_target("slack://team/channel").unwrap_err();
        assert!(
            err.to_string().contains("unknown binding scheme"),
            "got: {err}"
        );
    }
}
