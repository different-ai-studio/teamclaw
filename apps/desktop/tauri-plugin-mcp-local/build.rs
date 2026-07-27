const COMMANDS: &[&str] = &["push_log", "push_ipc"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
