//! Shim so the app always has an IrohState type for Tauri state.
//! When the p2p feature is off (e.g. Windows build), this is a dummy type.

#[cfg(feature = "p2p")]
pub use super::team_p2p::IrohState;

#[cfg(feature = "p2p")]
pub use super::team_p2p::SyncEngineState;

#[cfg(not(feature = "p2p"))]
use std::sync::Arc;
#[cfg(not(feature = "p2p"))]
use tokio::sync::Mutex;
#[cfg(not(feature = "p2p"))]
pub type IrohState = Arc<Mutex<Option<()>>>;

#[cfg(not(feature = "p2p"))]
pub type SyncEngineState = Arc<Mutex<Option<()>>>;
