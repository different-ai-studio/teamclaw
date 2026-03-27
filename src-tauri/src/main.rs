// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let _sentry_guard = sentry::init(("https://f7626cc6e80f4561b1673dd027742714@o60909.ingest.us.sentry.io/4511110362169344", sentry::ClientOptions {
        release: sentry::release_name!(),
        send_default_pii: true,
        ..Default::default()
    }));

    teamclaw_lib::run()
}
