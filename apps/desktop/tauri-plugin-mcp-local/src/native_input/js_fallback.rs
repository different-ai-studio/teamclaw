// JS fallback is used on Windows/Linux where native injection isn't implemented yet.
// On macOS, the macos backend handles everything natively.
#![allow(dead_code)]

use tauri::{Runtime, Webview};
use crate::error::Error;
use super::{MouseParams, TextParams, MouseButton, InputResult, TextResult};

/// Inject mouse events via JS synthetic event dispatch.
/// Note: isTrusted=false — some frameworks may ignore these events,
/// and CSS :hover will not be triggered.
pub fn inject_mouse_via_js<R: Runtime>(
    webview: &Webview<R>,
    params: &MouseParams,
) -> Result<InputResult, Error> {
    let x = params.x;
    let y = params.y;

    // Always dispatch mousemove
    let mut js = format!(
        r#"(function() {{
            var el = document.elementFromPoint({x}, {y}) || document.body;
            el.dispatchEvent(new MouseEvent('mousemove', {{
                clientX: {x}, clientY: {y}, bubbles: true, cancelable: true
            }}));
        "#,
        x = x, y = y
    );

    let button_num = match params.button {
        MouseButton::Left => 0,
        MouseButton::Right => 2,
        MouseButton::Middle => 1,
    };

    if params.click {
        js.push_str(&format!(
            r#"
            el.dispatchEvent(new MouseEvent('mousedown', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            el.dispatchEvent(new MouseEvent('mouseup', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            el.dispatchEvent(new MouseEvent('click', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            "#,
            x = x, y = y, btn = button_num
        ));

        // Focus the nearest typeable ancestor and store click coords for fallback recovery
        js.push_str(&format!(
            r#"
            window.__mcpLastClickCoords={{x:{x},y:{y}}};
            var ft=el;
            while(ft&&ft!==document.body){{
                var ftag=ft.tagName;
                if(ftag==='INPUT'||ftag==='TEXTAREA'||ftag==='SELECT') break;
                if(ft.isContentEditable) break;
                if(ft.hasAttribute&&(ft.hasAttribute('data-lexical-editor')||ft.hasAttribute('data-slate-editor'))) break;
                if(ft.closest&&(ft.closest('[data-lexical-editor]')||ft.closest('[data-slate-editor]'))) break;
                ft=ft.parentElement;
            }}
            if(ft&&ft!==document.body&&ft.focus){{ft.focus({{preventScroll:true}});}}
            "#,
            x = x, y = y
        ));
    } else if params.mouse_down {
        js.push_str(&format!(
            r#"
            el.dispatchEvent(new MouseEvent('mousedown', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            "#,
            x = x, y = y, btn = button_num
        ));
    } else if params.mouse_up {
        js.push_str(&format!(
            r#"
            el.dispatchEvent(new MouseEvent('mouseup', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            "#,
            x = x, y = y, btn = button_num
        ));
    }

    js.push_str("})();");

    webview.eval(&js).map_err(|e| {
        Error::Anyhow(format!("Failed to inject mouse event via JS: {}", e))
    })?;

    Ok(InputResult {
        success: true,
        position: (x, y),
        error: None,
    })
}

/// Inject text via JS synthetic events.
/// Uses React-compatible nativeInputValueSetter for <input>/<textarea>,
/// and document.execCommand('insertText') for contenteditable.
pub fn inject_text_via_js<R: Runtime>(
    webview: &Webview<R>,
    params: &TextParams,
) -> Result<TextResult, Error> {
    // Serialize the text as a JSON string literal (valid JS), which safely
    // escapes quotes, backslashes, control chars, and U+2028/U+2029.
    let text_json = serde_json::to_string(&params.text)
        .map_err(|e| Error::Anyhow(format!("Failed to encode text as JSON: {}", e)))?;

    let delay_ms = params.delay_ms;

    // Use document.execCommand('insertText') for input/textarea elements.
    // This triggers the browser's native input pipeline which produces a real
    // InputEvent that React's controlled components recognize. Direct
    // element.value assignment + synthetic Event('input') does NOT work
    // because React's internal fiber value tracker never registers the change.
    let js = if delay_ms > 0 {
        // Paced typing: inject one character at a time with setTimeout delays
        format!(
            r#"(function() {{
            var text = {text};
            var delay = {delay};
            function typeChar(i) {{
                if (i >= text.length) return;
                var el = document.activeElement;
                if (!el) return;
                var ch = text[i];
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                    document.execCommand('insertText', false, ch);
                }} else if (el.isContentEditable) {{
                    document.execCommand('insertText', false, ch);
                }} else {{
                    el.dispatchEvent(new KeyboardEvent('keydown', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                    el.dispatchEvent(new KeyboardEvent('keypress', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                    el.dispatchEvent(new KeyboardEvent('keyup', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                }}
                setTimeout(function() {{ typeChar(i + 1); }}, delay);
            }}
            typeChar(0);
        }})();"#,
            text = text_json, delay = delay_ms
        )
    } else {
        // Immediate: inject all text at once
        format!(
            r#"(function() {{
            var text = {text};
            var el = document.activeElement;
            if (!el) return;

            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {{
                document.execCommand('insertText', false, text);
            }} else {{
                // Generic fallback: try typing via keyboard events
                for (var i = 0; i < text.length; i++) {{
                    var ch = text[i];
                    el.dispatchEvent(new KeyboardEvent('keydown', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                    el.dispatchEvent(new KeyboardEvent('keypress', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                    el.dispatchEvent(new KeyboardEvent('keyup', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                }}
            }}
        }})();"#,
            text = text_json
        )
    };

    webview.eval(&js).map_err(|e| {
        Error::Anyhow(format!("Failed to inject text via JS: {}", e))
    })?;

    // Block until paced typing completes to match macOS backend's synchronous behavior.
    // The JS uses setTimeout chains, so webview.eval() returns immediately.
    if delay_ms > 0 {
        let chars_count = params.text.chars().count() as u64;
        if chars_count > 1 {
            let total_ms = delay_ms * (chars_count - 1) + 50;
            std::thread::sleep(std::time::Duration::from_millis(total_ms));
        }
    }

    let chars_typed = params.text.chars().count() as u32;
    Ok(TextResult {
        success: true,
        chars_typed,
        error: None,
    })
}
