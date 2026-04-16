//! Shim so the app always has an IrohState type for Tauri state.
//! When the p2p feature is off (e.g. Windows build), this is a dummy type.
//! Each dummy uses a distinct newtype wrapper so Tauri's type-keyed state
//! manager doesn't panic from registering the same concrete type twice.

#[cfg(feature = "p2p")]
pub use teamclaw_p2p::IrohState;

#[cfg(feature = "p2p")]
pub use teamclaw_p2p::SyncEngineState;

#[cfg(not(feature = "p2p"))]
use std::sync::Arc;
#[cfg(not(feature = "p2p"))]
use tokio::sync::Mutex;

#[cfg(not(feature = "p2p"))]
pub struct IrohState(pub Arc<Mutex<Option<()>>>);

#[cfg(not(feature = "p2p"))]
impl Default for IrohState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

#[cfg(not(feature = "p2p"))]
pub struct SyncEngineState(pub Arc<Mutex<Option<()>>>);

#[cfg(not(feature = "p2p"))]
impl Default for SyncEngineState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}
