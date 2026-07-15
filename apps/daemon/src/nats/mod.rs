//! NATS backend for the amuxd transport switch. Mirrors the shape of
//! [`crate::mqtt::MqttClient`] so the daemon's connect / subscribe / event
//! loop can dispatch over either backend via [`crate::transport::DaemonBackend`].
//!
//! Layout:
//!
//! - [`client`]: connect + topic-bound publish/subscribe glue
//! - [`retained`]: JetStream KV bucket that replaces MQTT retained messages
//!   for actor/runtime state
//!
//! Note: this module does not yet drive the daemon's main loop — that swap
//! is staged as a follow-up commit so the MQTT path stays intact and
//! shippable while NATS support stabilizes.

pub mod client;
pub mod retained;

pub use client::NatsBackend;
