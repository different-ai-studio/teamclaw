use enigo::Key;

/// Map a human-readable key name (case-insensitive) to an [`enigo::Key`].
///
/// Accepts names like `"cmd"`, `"ctrl"`, `"enter"`, `"f1"`, single characters,
/// and so on.  Unknown names are returned as `Key::Unicode(first_char)` if the
/// string is exactly one character, otherwise `None`.
pub fn map_key(name: &str) -> Option<Key> {
    let lower = name.to_lowercase();
    let lower = lower.trim();

    // -- Modifier aliases --
    let key = match lower {
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Key::Meta,
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,

        // -- Common keys --
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "space" | " " => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "escape" | "esc" => Key::Escape,
        "capslock" => Key::CapsLock,
        "numlock" => Key::Other(0x90), // VK_NUMLOCK – not natively in enigo 0.6

        // -- Navigation --
        "up" | "uparrow" => Key::UpArrow,
        "down" | "downarrow" => Key::DownArrow,
        "left" | "leftarrow" => Key::LeftArrow,
        "right" | "rightarrow" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,

        // -- Function keys --
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,

        // -- Media keys --
        "volumeup" => Key::VolumeUp,
        "volumedown" => Key::VolumeDown,
        "volumemute" | "mute" => Key::VolumeMute,
        "medianext" | "medianexttrack" => Key::MediaNextTrack,
        "mediaprev" | "mediaprevtrack" => Key::MediaPrevTrack,
        "mediaplay" | "mediaplaypause" => Key::MediaPlayPause,
        "mediastop" => Key::Other(0xB2), // VK_MEDIA_STOP

        // -- Misc --
        "insert" => Key::Other(0x2D),     // VK_INSERT
        "printscreen" | "printscr" | "prtsc" => Key::Other(0x2C), // VK_SNAPSHOT
        "scrolllock" => Key::Other(0x91), // VK_SCROLL
        "pause" | "break" => Key::Other(0x13), // VK_PAUSE

        // -- Single character → Unicode --
        other => {
            let chars: Vec<char> = other.chars().collect();
            if chars.len() == 1 {
                return Some(Key::Unicode(chars[0]));
            }
            return None;
        }
    };

    Some(key)
}

/// Parse a combo string such as `"ctrl+shift+a"` into a `Vec<Key>`.
///
/// Returns `None` if any part cannot be mapped.
pub fn parse_combo(combo: &str) -> Option<Vec<Key>> {
    combo.split('+').map(|part| map_key(part.trim())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_mapping() {
        assert_eq!(map_key("cmd"), Some(Key::Meta));
        assert_eq!(map_key("Ctrl"), Some(Key::Control));
        assert_eq!(map_key("ENTER"), Some(Key::Return));
        assert_eq!(map_key("a"), Some(Key::Unicode('a')));
    }

    #[test]
    fn combo_parsing() {
        let combo = parse_combo("ctrl+c").unwrap();
        assert_eq!(combo, vec![Key::Control, Key::Unicode('c')]);
    }
}
