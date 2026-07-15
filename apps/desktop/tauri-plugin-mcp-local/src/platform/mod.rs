// Platform module - conditionally exports the appropriate platform implementation

// Add shared module for common functionality
pub mod shared;

// Define platform-specific modules
#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub mod unix;

// Re-export the current platform implementation under a common name
#[cfg(target_os = "macos")]
pub use self::macos as current;

#[cfg(target_os = "windows")]
pub use self::windows as current;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use self::unix as current;
