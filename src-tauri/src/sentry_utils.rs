/// Capture an error message to Sentry with optional context tags.
pub fn capture_error(message: &str) {
    sentry::capture_message(message, sentry::Level::Error);
}

/// Capture a warning message to Sentry.
pub fn capture_warning(message: &str) {
    sentry::capture_message(message, sentry::Level::Warning);
}

/// Capture a std::error::Error to Sentry, preserving the error chain.
pub fn capture_err<E: std::fmt::Display>(context: &str, err: &E) {
    sentry::capture_message(&format!("{}: {}", context, err), sentry::Level::Error);
}
