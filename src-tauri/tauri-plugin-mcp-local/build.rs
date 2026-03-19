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
    "type_text"
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
