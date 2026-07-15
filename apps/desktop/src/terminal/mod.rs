pub mod pty;
pub mod registry;
pub mod ring;
pub mod shell_integration;

#[allow(unused_imports)]
pub use registry::{Registry, TerminalError, TerminalId, TerminalStatus, TerminalSummary};
