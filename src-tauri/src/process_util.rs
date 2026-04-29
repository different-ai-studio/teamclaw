//! Cross-platform child-process spawning helpers.
//!
//! On Windows, spawning a console subprocess from a GUI app pops a flashing
//! cmd window unless the parent sets the `CREATE_NO_WINDOW` creation flag
//! (0x08000000). Every git/sqlite3/netstat/taskkill/npx call in this crate
//! goes through `std::process::Command` or `tokio::process::Command`, so we
//! provide a tiny trait extension that hides the window on Windows and is a
//! no-op on Unix.
//!
//! Usage:
//! ```ignore
//! use crate::process_util::CommandNoWindow;
//! Command::new("git").no_window().args(["status"]).output()?;
//! ```

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait CommandNoWindow {
    /// Hide the spawned console window on Windows. No-op elsewhere.
    fn no_window(&mut self) -> &mut Self;
}

impl CommandNoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl CommandNoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
