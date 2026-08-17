//! The capability token that lets a gateway agent reply into its own chat.
//!
//! The `send` MCP tool has to know which chat to send to. That used to be
//! baked into the tool process's argv (`--binding`), which forced the tool to
//! be registered per session — and registration only rides the fresh-attach
//! path, so a session something else had already attached (the desktop, or a
//! runtime resumed at daemon start) silently had no send tool at all. Worse,
//! nothing said so: the agent simply had no way to send and the file the user
//! asked for never arrived.
//!
//! So the tool is registered once per workspace with no identity in its argv,
//! and each turn's prompt carries the token instead. Two properties matter:
//!
//! * The token is *derived* from the binding, not randomly minted. A model
//!   that quoted the token out of an earlier turn keeps working across a
//!   daemon restart; a rotating value would have turned "it copied the older
//!   one" into an intermittent, unreproducible failure. Every token for a
//!   chat resolves to that same chat anyway, so rotation bought nothing.
//! * It is keyed on the device id, so it cannot be reconstructed from a
//!   binding alone — bindings appear in logs and in chat transcripts.
//!
//! The token is also the boundary: without one there is no target at all, so
//! a session that was never bound to a chat (a desktop conversation, say)
//! cannot address one, and a bound session can only reach its own.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Entries unused for this long are dropped. Pruning costs nothing: the token
/// is derived, so the next turn on that chat re-registers the same value.
const IDLE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Registry size beyond which a prune runs before inserting.
const PRUNE_THRESHOLD: usize = 512;

struct Entry {
    binding: String,
    /// The cloud session this chat is bound to, when the registering turn knew
    /// it. Carried so an outbound send can be written back into the same
    /// session the agent is answering in — without it a file the agent sends
    /// reaches the chat and exists nowhere else.
    session_id: Option<String>,
    last_used: Instant,
}

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The stable token for a chat binding.
pub fn token_for_binding(binding: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(crate::device_id::daemon_device_id().as_bytes());
    // Domain separator: keeps this hash from colliding with any other use of
    // the device id as a key.
    hasher.update(b"\0amuxd-send-reply-token\0");
    hasher.update(binding.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Derive the token for `binding` and remember the mapping so a later
/// `send` call can be resolved. Called once per gateway turn.
pub fn register(binding: &str) -> String {
    register_with_session(binding, None)
}

/// [`register`], additionally recording which cloud session this chat's turns
/// run in. Callers that know it should pass it: it is what lets an outbound
/// send be recorded as a session message.
pub fn register_with_session(binding: &str, session_id: Option<&str>) -> String {
    let token = token_for_binding(binding);
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if reg.len() >= PRUNE_THRESHOLD {
        let now = Instant::now();
        reg.retain(|_, e| now.duration_since(e.last_used) < IDLE_TTL);
    }
    // A re-register that does not know the session must not erase one an
    // earlier turn recorded.
    let session_id = session_id
        .map(str::to_string)
        .or_else(|| reg.get(&token).and_then(|e| e.session_id.clone()));
    reg.insert(
        token.clone(),
        Entry {
            binding: binding.to_string(),
            session_id,
            last_used: Instant::now(),
        },
    );
    token
}

/// The chat a token resolves to, or `None` if it was never registered on this
/// daemon or has aged out. Refreshes the entry's idle clock.
/// The cloud session behind a token, when a turn recorded one.
pub fn session_for(token: &str) -> Option<String> {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let entry = reg.get_mut(token)?;
    if Instant::now().duration_since(entry.last_used) >= IDLE_TTL {
        reg.remove(token);
        return None;
    }
    entry.last_used = Instant::now();
    entry.session_id.clone()
}

pub fn binding_for(token: &str) -> Option<String> {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let entry = reg.get_mut(token)?;
    if Instant::now().duration_since(entry.last_used) >= IDLE_TTL {
        reg.remove(token);
        return None;
    }
    entry.last_used = Instant::now();
    Some(entry.binding.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BINDING: &str = "wecom://bot/bot/single/LiangLiang";

    #[test]
    fn the_same_chat_always_derives_the_same_token() {
        // The point of deriving rather than minting: a token the model quoted
        // from an earlier turn must still resolve after a daemon restart.
        assert_eq!(token_for_binding(BINDING), token_for_binding(BINDING));
    }

    #[test]
    fn different_chats_get_different_tokens() {
        assert_ne!(
            token_for_binding(BINDING),
            token_for_binding("wecom://bot/bot/single/SomeoneElse")
        );
    }

    #[test]
    fn a_token_does_not_leak_the_binding_it_came_from() {
        let token = token_for_binding(BINDING);
        assert!(!token.contains("LiangLiang"));
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn registering_makes_the_token_resolvable() {
        let token = register("wecom://bot/bot/single/resolvable");
        assert_eq!(
            binding_for(&token).as_deref(),
            Some("wecom://bot/bot/single/resolvable")
        );
    }

    #[test]
    fn an_unregistered_token_resolves_to_nothing() {
        // What a session that was never bound to a chat gets: no target at all.
        assert_eq!(binding_for("deadbeef"), None);
        assert_eq!(binding_for(""), None);
    }

    #[test]
    fn re_registering_the_same_chat_is_idempotent() {
        let first = register("wecom://bot/bot/single/idempotent");
        let second = register("wecom://bot/bot/single/idempotent");
        assert_eq!(first, second);
        assert_eq!(
            binding_for(&second).as_deref(),
            Some("wecom://bot/bot/single/idempotent")
        );
    }

    #[test]
    fn a_token_carries_the_session_its_turn_runs_in() {
        // The outbound send path needs it: without a session id a file the
        // agent sends reaches the chat and is recorded nowhere.
        let binding = "wecom://bot-sess/bot-sess/single/u1";
        let token = register_with_session(binding, Some("sess-1"));
        assert_eq!(binding_for(&token).as_deref(), Some(binding));
        assert_eq!(session_for(&token).as_deref(), Some("sess-1"));
    }

    #[test]
    fn re_registering_without_a_session_keeps_the_known_one() {
        // Every turn re-registers. A turn that could not resolve the cloud
        // session must not erase what an earlier one recorded.
        let binding = "wecom://bot-keep/bot-keep/single/u2";
        let token = register_with_session(binding, Some("sess-2"));
        let again = register(binding);
        assert_eq!(again, token);
        assert_eq!(session_for(&token).as_deref(), Some("sess-2"));
    }

    #[test]
    fn a_token_registered_without_a_session_has_none() {
        let token = register("wecom://bot-none/bot-none/single/u3");
        assert!(session_for(&token).is_none());
    }
}
