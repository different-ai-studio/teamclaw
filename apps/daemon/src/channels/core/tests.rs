//! What the pipeline guarantees, pinned with fakes rather than a live bot.
//!
//! Every assertion here corresponds to something that is currently true on
//! exactly one channel, or true nowhere.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use super::*;
use teamclu_gateway::driver::{
    ChannelCaps, ConversationKind, ExternalSender, InboundAttachment, Threading,
};

#[derive(Default)]
struct FakeDedup {
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl DedupStore for FakeDedup {
    async fn claim(&self, channel: &str, id: &str) -> bool {
        let key = format!("{channel}:{id}");
        let mut seen = self.seen.lock().unwrap();
        if seen.contains(&key) {
            return false;
        }
        seen.push(key);
        true
    }
}

struct FakeRouter;
#[async_trait]
impl SessionRouter for FakeRouter {
    async fn resolve(&self, c: &Conversation) -> Result<String, CoreError> {
        // Proves bot_id is load-bearing: two bots in one chat must not share.
        Ok(format!(
            "session-{}-{}-{}",
            c.channel,
            c.bot_id.as_deref().unwrap_or("nobot"),
            c.id
        ))
    }
}

struct FakeIdentity;
#[async_trait]
impl IdentityMapper for FakeIdentity {
    async fn actor_for(&self, _s: &str, sender: &ExternalSender) -> Result<String, CoreError> {
        Ok(format!("actor-{}", sender.external_id))
    }
}

#[derive(Default)]
struct FakeWriter {
    inbound: Mutex<Vec<(String, String, usize)>>, // (text, actor, attachment count)
    replies: Mutex<Vec<String>>,
    /// Ordering witness: what happened, in the order it happened.
    log: Mutex<Vec<&'static str>>,
}

#[async_trait]
impl SessionWriter for FakeWriter {
    async fn write_inbound(
        &self,
        _session: &str,
        actor: &str,
        text: &str,
        attachments: Vec<PendingUpload>,
        _external: &str,
    ) -> Result<String, CoreError> {
        self.log.lock().unwrap().push("write_inbound");
        self.inbound
            .lock()
            .unwrap()
            .push((text.to_string(), actor.to_string(), attachments.len()));
        Ok("msg-in".into())
    }

    async fn write_reply(
        &self,
        _session: &str,
        text: &str,
        _attachments: Vec<SessionAttachment>,
    ) -> Result<String, CoreError> {
        self.log.lock().unwrap().push("write_reply");
        self.replies.lock().unwrap().push(text.to_string());
        Ok("msg-out".into())
    }
}

struct FakeTurns {
    reply: &'static str,
    deltas: Vec<&'static str>,
    log: Arc<Mutex<Vec<&'static str>>>,
}

#[async_trait]
impl TurnRunner for FakeTurns {
    async fn run(
        &self,
        _session: &str,
        _prompt: &str,
        on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        self.log.lock().unwrap().push("turn");
        if let Some(tx) = on_delta {
            for d in &self.deltas {
                let _ = tx.send(d.to_string()).await;
            }
        }
        Ok(self.reply.to_string())
    }
}

#[derive(Default)]
struct FakeSink {
    delivered: AtomicUsize,
    updates: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl ReplySink for FakeSink {
    async fn deliver(
        &self,
        _to: &Conversation,
        msg: &OutboundMessage,
    ) -> Result<DeliveryHandle, CoreError> {
        self.delivered.fetch_add(1, Ordering::SeqCst);
        self.updates.lock().unwrap().push((msg.text.clone(), true));
        Ok(DeliveryHandle("d-1".into()))
    }

    async fn update(
        &self,
        _h: &DeliveryHandle,
        text: &str,
        finished: bool,
    ) -> Result<(), CoreError> {
        self.updates
            .lock()
            .unwrap()
            .push((text.to_string(), finished));
        Ok(())
    }
}

fn core(turns: FakeTurns) -> (Core, Arc<FakeWriter>) {
    let writer = Arc::new(FakeWriter::default());
    (
        Core {
            dedup: Arc::new(FakeDedup::default()),
            router: Arc::new(FakeRouter),
            identity: Arc::new(FakeIdentity),
            writer: writer.clone(),
            turns: Arc::new(turns),
        },
        writer,
    )
}

fn turns(
    reply: &'static str,
    deltas: Vec<&'static str>,
) -> (FakeTurns, Arc<Mutex<Vec<&'static str>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    (
        FakeTurns {
            reply,
            deltas,
            log: log.clone(),
        },
        log,
    )
}

fn inbound(text: &str) -> InboundMessage {
    InboundMessage {
        conversation: Conversation {
            channel: "wecom",
            bot_id: Some("bot-a".into()),
            kind: ConversationKind::Direct,
            id: "u-1".into(),
        },
        sender: ExternalSender {
            external_id: "u-1".into(),
            display_name: "Someone".into(),
            email: None,
        },
        external_message_id: "m-1".into(),
        text: text.into(),
        attachments: Vec::new(),
        addressed_to_bot: true,
        quoted_text: None,
    }
}

const IM: ChannelCaps = ChannelCaps {
    streaming_edit: true,
    media_upload: true,
    interactive: true,
    threading: Threading::Inline,
    max_chars: 2048,
    turn_timeout_secs: 180,
};

const MAIL: ChannelCaps = ChannelCaps {
    streaming_edit: false,
    media_upload: true,
    interactive: false,
    threading: Threading::MailHeaders,
    max_chars: 100_000,
    // A mail round trip is minutes, not the IM-shaped 180s in session_queue.rs.
    turn_timeout_secs: 900,
};

#[tokio::test]
async fn the_inbound_message_is_written_before_the_turn_runs() {
    // The symptom this prevents: a three-minute turn during which the user's
    // own message exists nowhere, then both rows land 39ms apart.
    let (t, log) = turns("done", vec![]);
    let (core, writer) = core(t);
    let sink = FakeSink::default();
    core.handle(MAIL, &sink, inbound("hi")).await.unwrap();

    let writes = writer.log.lock().unwrap().clone();
    let turn_ran = log.lock().unwrap().clone();
    assert_eq!(writes[0], "write_inbound");
    assert_eq!(turn_ran, vec!["turn"], "the turn ran");
    assert_eq!(writes[1], "write_reply", "the reply is written too");
}

#[tokio::test]
async fn a_redelivered_message_produces_no_second_turn() {
    let (t, log) = turns("done", vec![]);
    let (core, _w) = core(t);
    let sink = FakeSink::default();

    let first = core.handle(IM, &sink, inbound("hi")).await.unwrap();
    let second = core.handle(IM, &sink, inbound("hi")).await.unwrap();

    assert!(matches!(first, Outcome::Handled { .. }));
    assert_eq!(second, Outcome::Duplicate);
    assert_eq!(log.lock().unwrap().len(), 1, "exactly one turn");
}

#[tokio::test]
async fn a_group_message_that_does_not_address_the_bot_is_ignored() {
    let (t, log) = turns("done", vec![]);
    let (core, _w) = core(t);
    let sink = FakeSink::default();
    let mut msg = inbound("chatter between humans");
    msg.conversation.kind = ConversationKind::Group;
    msg.addressed_to_bot = false;

    assert_eq!(
        core.handle(IM, &sink, msg).await.unwrap(),
        Outcome::NotAddressed
    );
    assert!(log.lock().unwrap().is_empty(), "no turn, no write");
}

#[tokio::test]
async fn a_bare_mention_says_nothing_and_starts_nothing() {
    let (t, _log) = turns("done", vec![]);
    let (core, _w) = core(t);
    let sink = FakeSink::default();
    assert_eq!(
        core.handle(IM, &sink, inbound("   ")).await.unwrap(),
        Outcome::Empty
    );
}

#[tokio::test]
async fn a_channel_that_cannot_edit_gets_exactly_one_delivery() {
    // Email. The turn still streams internally — the session and the desktop
    // see deltas — the channel just receives the finished text once.
    let (t, _log) = turns("the whole answer", vec!["the", "the whole"]);
    let (core, _w) = core(t);
    let sink = FakeSink::default();

    let outcome = core.handle(MAIL, &sink, inbound("hi")).await.unwrap();
    assert_eq!(
        outcome,
        Outcome::Handled {
            session_id: "session-wecom-bot-a-u-1".into(),
            deliveries: 1
        }
    );
    let updates = sink.updates.lock().unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].0, "the whole answer");
}

#[tokio::test]
async fn a_channel_that_can_edit_sees_every_delta() {
    let (t, _log) = turns("Hello world", vec!["He", "Hello", "Hello wo"]);
    let (core, _w) = core(t);
    let sink = FakeSink::default();

    core.handle(IM, &sink, inbound("hi")).await.unwrap();

    let updates = sink.updates.lock().unwrap();
    // opening empty delivery + 3 deltas + final
    assert_eq!(updates.len(), 5);
    assert_eq!(updates.last().unwrap().0, "Hello world");
    assert!(updates.last().unwrap().1, "the last edit is marked final");
}

#[tokio::test]
async fn the_session_key_separates_two_bots_in_one_chat() {
    let (t, _log) = turns("done", vec![]);
    let (core, _w) = core(t);
    let sink = FakeSink::default();

    let mut a = inbound("hi");
    a.conversation.kind = ConversationKind::Group;
    a.conversation.id = "chat-1".into();
    let mut b = copy_without_attachments(&a);
    b.conversation.bot_id = Some("bot-b".into());
    b.external_message_id = "m-2".into();

    let Outcome::Handled { session_id: sa, .. } = core.handle(IM, &sink, a).await.unwrap() else {
        panic!("first message not handled")
    };
    let Outcome::Handled { session_id: sb, .. } = core.handle(IM, &sink, b).await.unwrap() else {
        panic!("second message not handled")
    };
    assert_ne!(sa, sb, "two bots in one chat must not share a session");
}

#[tokio::test]
async fn quoted_context_is_prepended_once_for_every_channel() {
    let (t, _log) = turns("done", vec![]);
    let (core, writer) = core(t);
    let sink = FakeSink::default();
    let mut msg = inbound("yes");
    msg.quoted_text = Some("pick one: a or b".into());

    core.handle(MAIL, &sink, msg).await.unwrap();

    let inbound_writes = writer.inbound.lock().unwrap();
    assert!(inbound_writes[0].0.contains("[Quoted message]"));
    assert!(inbound_writes[0].0.ends_with("yes"));
}

#[tokio::test]
async fn attachments_are_resolved_and_written_with_the_message() {
    // Inbound attachments exist on WeCom today and nowhere else. Here they are
    // a property of the pipeline, so a channel gets them by having them.
    let (t, _log) = turns("done", vec![]);
    let (core, writer) = core(t);
    let sink = FakeSink::default();
    let mut msg = inbound("see attached");
    msg.attachments.push(InboundAttachment {
        filename: "report.pdf".into(),
        mime: "application/pdf".into(),
        size_hint: Some(3),
        source: teamclu_gateway::driver::AttachmentSource::Ready(vec![1, 2, 3]),
    });

    core.handle(MAIL, &sink, msg).await.unwrap();

    let inbound_writes = writer.inbound.lock().unwrap();
    assert_eq!(inbound_writes[0].2, 1, "the attachment reached the write");
}

#[tokio::test]
async fn the_sender_is_the_human_not_the_bot() {
    let (t, _log) = turns("done", vec![]);
    let (core, writer) = core(t);
    let sink = FakeSink::default();
    core.handle(MAIL, &sink, inbound("hi")).await.unwrap();
    assert_eq!(writer.inbound.lock().unwrap()[0].1, "actor-u-1");
}

/// Test-only shallow copy: `InboundAttachment` is deliberately not `Clone` (an
/// attachment fetch is not something to duplicate by accident), and the type
/// belongs to another crate, so this is a free function rather than an impl.
fn copy_without_attachments(msg: &InboundMessage) -> InboundMessage {
    InboundMessage {
        conversation: msg.conversation.clone(),
        sender: msg.sender.clone(),
        external_message_id: msg.external_message_id.clone(),
        text: msg.text.clone(),
        attachments: Vec::new(),
        addressed_to_bot: msg.addressed_to_bot,
        quoted_text: msg.quoted_text.clone(),
    }
}
