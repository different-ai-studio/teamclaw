const COMMANDS: &[&str] = &[
    "click_element",
    "control_window",
    "eval_js",
    "get_element_text",
    "get_html",
    "get_title",
    "get_url",
    "list_windows",
    "ping",
    "set_element_value",
    "take_screenshot",
    "type_text",
];

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("Cargo must set CARGO_MANIFEST_DIR for build scripts");
    println!("cargo:rerun-if-changed={}/permissions", manifest_dir);

    tauri_plugin::Builder::new(COMMANDS).build();
}
