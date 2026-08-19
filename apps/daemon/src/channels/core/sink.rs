//! Where a gateway hands a normalized message to the core.
//!
//! The gateway crate cannot call the daemon (it is a leaf both the daemon and
//! the desktop depend on), so the daemon implements
//! [`teamclu_gateway::driver::InboundSink`] and injects it at boot.

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::{ChannelDriver, InboundMessage, InboundSink};

use super::{Core, Outcome};

/// One channel's inbound edge: its driver plus the shared pipeline.
pub struct CoreSink {
    pub core: Arc<Core>,
    pub driver: Arc<dyn ChannelDriver>,
}

#[async_trait]
impl InboundSink for CoreSink {
    async fn accept(&self, msg: InboundMessage) {
        let channel = msg.conversation.channel;
        let external_id = msg.external_message_id.clone();
        // Spawned so the transport's read loop keeps draining while a turn
        // runs. A turn is minutes on a slow model; holding the websocket loop
        // for it would stall every other conversation on the same connection.
        let core = self.core.clone();
        let driver = self.driver.clone();
        tokio::spawn(async move {
            match core.handle(driver.as_ref(), msg).await {
                Ok(Outcome::Handled {
                    session_id,
                    deliveries,
                }) => {
                    tracing::info!(channel, session_id, deliveries, "gateway: turn complete");
                }
                Ok(other) => {
                    tracing::debug!(channel, external_id, ?other, "gateway: message not a turn");
                }
                Err(e) => {
                    // Loud: the sender is waiting and nothing else reports this.
                    tracing::error!(channel, external_id, error = %e, "gateway: message failed");
                }
            }
        });
    }
}

/// Whether this daemon routes gateways through the core pipeline.
///
/// On by default. `TEAMCLU_GATEWAY_CORE=0` falls back to each gateway's inline
/// handler — a switch for the first live round trip, to be deleted with the
/// inline handlers once that has happened.
pub fn core_pipeline_enabled() -> bool {
    !matches!(
        std::env::var("TEAMCLU_GATEWAY_CORE").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_core_pipeline_is_on_unless_explicitly_turned_off() {
        // A typo'd value must not silently disable it: only the three spellings
        // of "off" count, everything else stays on.
        let cases = [
            (None, true),
            (Some("0"), false),
            (Some("false"), false),
            (Some("off"), false),
            (Some("1"), true),
            (Some("yes"), true),
            (Some(""), true),
        ];
        for (value, expected) in cases {
            match value {
                Some(v) => std::env::set_var("TEAMCLU_GATEWAY_CORE", v),
                None => std::env::remove_var("TEAMCLU_GATEWAY_CORE"),
            }
            assert_eq!(core_pipeline_enabled(), expected, "for {value:?}");
        }
        std::env::remove_var("TEAMCLU_GATEWAY_CORE");
    }
}
