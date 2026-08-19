//! The one implementation of "a channel message becomes a session turn".
//!
//! Prototype for `docs/specs/2026-08-18-gateway-transport-architecture.md`.
//! Not wired into gateway boot yet: it exists to pin the stage order and the
//! downgrade rules with tests before any channel is rewritten against it.
//!
//! Why it lives in the daemon and not in `teamclu-gateway` (§4.1): everything
//! it needs — the session write service, live publishing, runtime lifecycle,
//! actor mapping — is daemon-side. The gateway crate is a leaf that both the
//! daemon and the desktop depend on; putting the pipeline there would invert
//! that.
//!
//! The stages, in order, each of which used to be re-implemented per channel:
//!
//! ```text
//! dedup → addressed? → identity → write+broadcast → turn → render (downgraded)
//! ```
//!
//! Everything here is unused until a channel is rewritten against it, which is
//! the point of landing it first: the contract gets reviewed and pinned by
//! tests before 3000 lines of WeCom are moved onto it. The allow goes away with
//! the first real caller.
#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::{
    ChannelCaps, Conversation, InboundMessage, OutboundMessage, SessionAttachment,
};

/// Remembers which channel messages have already been handled.
///
/// One store for every channel, replacing three mechanisms that each forget
/// differently: an in-memory set (WeCom), nothing at all (Feishu), and a UID
/// watermark plus a sqlite table (email).
#[async_trait]
pub trait DedupStore: Send + Sync {
    /// True when this is the first sighting. Must claim atomically: a webhook
    /// redelivered while the first copy is still in flight has to lose.
    async fn claim(&self, channel: &str, external_message_id: &str) -> bool;
}

/// Resolves a channel conversation to the session it belongs to, creating one
/// on first contact.
#[async_trait]
pub trait SessionRouter: Send + Sync {
    async fn resolve(&self, conversation: &Conversation) -> Result<String, CoreError>;
}

/// Maps a channel user onto an actor, so a gateway message has a real sender
/// rather than "the bot".
#[async_trait]
pub trait IdentityMapper: Send + Sync {
    async fn actor_for(
        &self,
        session_id: &str,
        sender: &teamclu_gateway::driver::ExternalSender,
    ) -> Result<String, CoreError>;
}

/// The #933 write service: insert, broadcast, and attach — in that order, once.
#[async_trait]
pub trait SessionWriter: Send + Sync {
    /// Records an inbound message and publishes `message.created`.
    async fn write_inbound(
        &self,
        session_id: &str,
        actor_id: &str,
        text: &str,
        attachments: Vec<PendingUpload>,
        external_message_id: &str,
    ) -> Result<String, CoreError>;

    /// Records the agent's reply the same way, so both directions look alike.
    async fn write_reply(
        &self,
        session_id: &str,
        text: &str,
        attachments: Vec<SessionAttachment>,
    ) -> Result<String, CoreError>;
}

/// An attachment resolved to bytes, ready for the store to upload.
pub struct PendingUpload {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// Runs the turn. Streaming is offered unconditionally; whether the *channel*
/// shows the intermediate text is decided later, by caps.
#[async_trait]
pub trait TurnRunner: Send + Sync {
    async fn run(
        &self,
        session_id: &str,
        prompt: &str,
        on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError>;
}

/// What the core did, for the caller to log or assert on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Already seen — the dedup gate closed.
    Duplicate,
    /// A group message that did not address the bot.
    NotAddressed,
    /// Addressed, but carried no text after normalization (a bare mention).
    Empty,
    Handled {
        session_id: String,
        /// How many times the channel was asked to render. One for a channel
        /// that cannot edit; more when it streams.
        deliveries: usize,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("route: {0}")]
    Route(String),
    #[error("identity: {0}")]
    Identity(String),
    #[error("write: {0}")]
    Write(String),
    #[error("turn: {0}")]
    Turn(String),
    #[error("render: {0}")]
    Render(String),
}

/// Where the reply goes. The core never touches a protocol; it hands text to
/// this and lets the driver decide how a message is shaped.
#[async_trait]
pub trait ReplySink: Send + Sync {
    async fn deliver(
        &self,
        to: &Conversation,
        msg: &OutboundMessage,
    ) -> Result<DeliveryHandle, CoreError>;
    async fn update(
        &self,
        handle: &DeliveryHandle,
        text: &str,
        finished: bool,
    ) -> Result<(), CoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryHandle(pub String);

pub struct Core {
    pub dedup: Arc<dyn DedupStore>,
    pub router: Arc<dyn SessionRouter>,
    pub identity: Arc<dyn IdentityMapper>,
    pub writer: Arc<dyn SessionWriter>,
    pub turns: Arc<dyn TurnRunner>,
}

impl Core {
    /// One inbound message, start to finish.
    pub async fn handle(
        &self,
        caps: ChannelCaps,
        sink: &dyn ReplySink,
        msg: InboundMessage,
    ) -> Result<Outcome, CoreError> {
        // 1. Dedup first: everything below this line has side effects, and a
        //    redelivered webhook must not produce a second turn.
        if !self
            .dedup
            .claim(msg.conversation.channel, &msg.external_message_id)
            .await
        {
            return Ok(Outcome::Duplicate);
        }

        if !msg.addressed_to_bot {
            return Ok(Outcome::NotAddressed);
        }
        if msg.text.trim().is_empty() && msg.attachments.is_empty() {
            return Ok(Outcome::Empty);
        }

        // 2. Route and identify before writing: a message needs a session to
        //    live in and a sender to be attributed to.
        let session_id = self.router.resolve(&msg.conversation).await?;
        let actor_id = self.identity.actor_for(&session_id, &msg.sender).await?;

        // 3. Resolve attachments. Deferred by construction, so a text-only
        //    message spends nothing here — which is what keeps the common case
        //    starting its turn immediately.
        let mut uploads = Vec::new();
        for att in &msg.attachments {
            let bytes = match &att.source {
                teamclu_gateway::driver::AttachmentSource::Ready(b) => b.clone(),
                teamclu_gateway::driver::AttachmentSource::Deferred(f) => f
                    .fetch()
                    .await
                    .map_err(|e| CoreError::Write(format!("attachment fetch: {e}")))?,
            };
            uploads.push(PendingUpload {
                filename: att.filename.clone(),
                mime: att.mime.clone(),
                bytes,
            });
        }

        // 4. Write BEFORE the turn, always. Writing after is what made a
        //    three-minute turn look like a frozen client on every other
        //    surface, then dropped both rows in at once.
        let prompt = compose_prompt(&msg);
        self.writer
            .write_inbound(
                &session_id,
                &actor_id,
                &prompt,
                uploads,
                &msg.external_message_id,
            )
            .await?;

        // 5. Drive the turn, streaming only when the channel can show it.
        let deliveries = if caps.streaming_edit {
            self.run_streamed(sink, &msg.conversation, &session_id, &prompt)
                .await?
        } else {
            self.run_buffered(sink, &msg.conversation, &session_id, &prompt)
                .await?
        };

        Ok(Outcome::Handled {
            session_id,
            deliveries,
        })
    }

    /// Channels that cannot edit a sent message get one delivery at the end.
    /// The turn still streams internally — the session and every other client
    /// see the deltas, the channel just sees the result.
    async fn run_buffered(
        &self,
        sink: &dyn ReplySink,
        to: &Conversation,
        session_id: &str,
        prompt: &str,
    ) -> Result<usize, CoreError> {
        let reply = self.turns.run(session_id, prompt, None).await?;
        self.writer
            .write_reply(session_id, &reply, Vec::new())
            .await?;
        sink.deliver(
            to,
            &OutboundMessage {
                text: reply,
                ..Default::default()
            },
        )
        .await?;
        Ok(1)
    }

    async fn run_streamed(
        &self,
        sink: &dyn ReplySink,
        to: &Conversation,
        session_id: &str,
        prompt: &str,
    ) -> Result<usize, CoreError> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(16);
        let handle = sink.deliver(to, &OutboundMessage::default()).await?;

        let turns = self.turns.clone();
        let session = session_id.to_string();
        let prompt_owned = prompt.to_string();
        let turn = tokio::spawn(async move { turns.run(&session, &prompt_owned, Some(tx)).await });

        let mut updates = 0usize;
        while let Some(text) = rx.recv().await {
            sink.update(&handle, &text, false).await?;
            updates += 1;
        }

        let reply = turn
            .await
            .map_err(|e| CoreError::Turn(format!("turn task: {e}")))??;
        sink.update(&handle, &reply, true).await?;
        self.writer
            .write_reply(session_id, &reply, Vec::new())
            .await?;
        // The opening delivery, every intermediate edit, and the final one.
        Ok(1 + updates + 1)
    }
}

/// The text the agent actually sees.
///
/// Quoted context is prepended here — one rule for every channel, instead of
/// each gateway inventing its own marker format.
fn compose_prompt(msg: &InboundMessage) -> String {
    match &msg.quoted_text {
        Some(q) if !q.is_empty() => {
            format!(
                "[Quoted message]\n{q}\n[End quoted message]\n\n{}",
                msg.text
            )
        }
        _ => msg.text.clone(),
    }
}

#[cfg(test)]
mod tests;
