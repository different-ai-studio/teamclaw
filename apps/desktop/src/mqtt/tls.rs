//! Desktop wrapper over the shared MQTT root store.
//!
//! The store itself lives in `teamclu_transport::tls` so the daemon shares it;
//! all this adds is the Sentry report, which the transport crate has no way to
//! emit. See that module for why rumqttc's `TlsConfiguration::default()` cannot
//! be used (it panics the process on a transient keychain read failure —
//! TEAMCLU-2G / TEAMCLU-20).

use std::sync::atomic::{AtomicBool, Ordering};

use rumqttc::TlsConfiguration;

/// The fallback is retried per connection attempt; the report is not.
static FALLBACK_REPORTED: AtomicBool = AtomicBool::new(false);

pub fn default_tls_config() -> TlsConfiguration {
    let resolved = teamclu_transport::tls::default_tls_config();
    if let Some(reason) = resolved.fallback_reason {
        if !FALLBACK_REPORTED.swap(true, Ordering::Relaxed) {
            crate::sentry_utils::capture_warning(&format!(
                "[mqtt-tls] platform certs unavailable, using bundled roots: {reason}"
            ));
        }
    }
    resolved.config
}
