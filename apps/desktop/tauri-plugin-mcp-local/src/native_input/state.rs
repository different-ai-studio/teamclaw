use std::sync::Mutex;

/// Tracks virtual cursor position since native event injection
/// doesn't move the OS cursor.
pub struct VirtualCursorState {
    position: Mutex<(i32, i32)>,
}

impl VirtualCursorState {
    pub fn new() -> Self {
        Self {
            position: Mutex::new((0, 0)),
        }
    }

    pub fn get(&self) -> (i32, i32) {
        *self.position.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set(&self, x: i32, y: i32) {
        let mut pos = self.position.lock().unwrap_or_else(|e| e.into_inner());
        *pos = (x, y);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_virtual_cursor_default() {
        let state = VirtualCursorState::new();
        assert_eq!(state.get(), (0, 0));
    }

    #[test]
    fn test_virtual_cursor_set_get() {
        let state = VirtualCursorState::new();
        state.set(100, 200);
        assert_eq!(state.get(), (100, 200));
        state.set(-50, 300);
        assert_eq!(state.get(), (-50, 300));
    }
}
