//! Stable URI/URN helpers for gateway sessions and external actors.
//!
//! Binding URI shape per spec:
//!   wecom://{corp_id}/{agent_id}/single/{userid}
//!   wecom://{corp_id}/{agent_id}/external-single/{external_userid}
//!   wecom://{corp_id}/{agent_id}/group/{chat_id}
//!   feishu://{app_id}/{chat_id}
//!   discord://{application_id}/{channel_id}
//!   kook://{guild_id_or_dm}/{channel_id}
//!   wechat://{ilink_account}/single/{from_user_id}
//!   email://{account_key}/thread/{thread_key}

pub fn wecom_dm(corp_id: &str, agent_id: &str, userid: &str) -> String {
    format!("wecom://{corp_id}/{agent_id}/single/{userid}")
}
pub fn wecom_external_dm(corp_id: &str, agent_id: &str, ext_userid: &str) -> String {
    format!("wecom://{corp_id}/{agent_id}/external-single/{ext_userid}")
}
pub fn wecom_group(corp_id: &str, agent_id: &str, chat_id: &str) -> String {
    format!("wecom://{corp_id}/{agent_id}/group/{chat_id}")
}
pub fn feishu(app_id: &str, chat_id: &str) -> String {
    format!("feishu://{app_id}/{chat_id}")
}
pub fn discord(application_id: &str, channel_id: &str) -> String {
    format!("discord://{application_id}/{channel_id}")
}
pub fn kook(scope: &str, channel_id: &str) -> String {
    format!("kook://{scope}/{channel_id}")
}
pub fn wechat_dm(ilink_account: &str, from_user_id: &str) -> String {
    format!("wechat://{ilink_account}/single/{from_user_id}")
}
pub fn email_thread(account_key: &str, thread_key: &str) -> String {
    format!("email://{account_key}/thread/{thread_key}")
}

pub fn urn_wecom_user(corp_id: &str, userid: &str) -> String {
    format!("wecom-user:{corp_id}:{userid}")
}
pub fn urn_wecom_ext(corp_id: &str, ext_userid: &str) -> String {
    format!("wecom-ext:{corp_id}:{ext_userid}")
}
pub fn urn_feishu_user(app_id: &str, open_id: &str) -> String {
    format!("feishu-user:{app_id}:{open_id}")
}
pub fn urn_discord_user(user_id: &str) -> String {
    format!("discord-user:{user_id}")
}
pub fn urn_kook_user(user_id: &str) -> String {
    format!("kook-user:{user_id}")
}
pub fn urn_wechat_user(ilink_account: &str, from_user_id: &str) -> String {
    format!("wechat-user:{ilink_account}:{from_user_id}")
}
pub fn urn_email_user(addr: &str) -> String {
    format!("email-user:{}", addr.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wecom_uris_round_trip() {
        assert_eq!(wecom_dm("c1", "a1", "bob"), "wecom://c1/a1/single/bob");
        assert_eq!(wecom_group("c1", "a1", "g1"), "wecom://c1/a1/group/g1");
    }
    #[test]
    fn email_urn_lowercases_addr() {
        assert_eq!(urn_email_user("Foo@Bar.com"), "email-user:foo@bar.com");
    }
}
