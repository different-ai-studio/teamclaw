use serde_json::{json, Value};
use tauri::{AppHandle, Runtime, Manager, Emitter, Listener};
use log::info;

use crate::error::Error;
use crate::socket_server::SocketResponse;

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Deserialize)]
pub struct StateDumpRequest {
    window_label: Option<String>,
    max_depth: Option<usize>,
    path: Option<String>,
    timeout_ms: Option<u64>,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct StateDumpResponse {
    state: Value,
    detected_libraries: Vec<String>,
    metadata: StateDumpMetadata,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct StateDumpMetadata {
    truncated: bool,
    max_depth_reached: bool,
    libraries_checked: Vec<String>,
    serialization_errors: Vec<String>,
}

pub async fn handle_state_dump<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: StateDumpRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for state_dump: {}", e)))?;

    // Get the window label or use "main" as default
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Generate the introspection JavaScript code
    let js_code = generate_state_dump_code(
        request.max_depth.unwrap_or(10),
        request.path.clone(),
    );

    // Execute the JavaScript in the window
    let (tx, rx) = std::sync::mpsc::channel();

    app.emit_to(&window_label, "execute-js", &js_code)
        .map_err(|e| Error::communication_error_with_context(
            "Failed to emit execute-js event",
            format!("window: {}, error: {}", window_label, e),
        ))?;

    // Listen for response
    app.once("execute-js-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for the response with timeout
    let timeout = std::time::Duration::from_millis(request.timeout_ms.unwrap_or(5000));
    let result_string = rx
        .recv_timeout(timeout)
        .map_err(|_| Error::timeout_error("state dump execution", request.timeout_ms.unwrap_or(5000)))?;

    // Parse the response
    let response_value: Value = serde_json::from_str(&result_string)
        .map_err(|e| Error::serialization_error(format!("Failed to parse state dump response: {}", e)))?;

    // Check if result contains an error
    if let Some(error) = response_value.get("error") {
        if let Some(error_str) = error.as_str() {
            return Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(error_str.to_string()),
            });
        }
    }

    // Extract and process the result
    if let Some(result) = response_value.get("result") {
        if let Some(result_str) = result.as_str() {
            // Parse the state dump result
            match serde_json::from_str::<Value>(result_str) {
                Ok(dump) => {
                    let data = serde_json::to_value(dump)
                        .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;

                    Ok(SocketResponse {
                        success: true,
                        data: Some(data),
                        error: None,
                    })
                }
                Err(e) => {
                    // If parsing fails, return the raw result
                    info!("[TAURI_MCP] Failed to parse state dump result: {}", e);
                    Ok(SocketResponse {
                        success: true,
                        data: Some(json!({
                            "raw_result": result_str,
                            "parse_error": e.to_string()
                        })),
                        error: None,
                    })
                }
            }
        } else {
            Ok(SocketResponse {
                success: false,
                data: None,
                error: Some("State dump result is not a string".to_string()),
            })
        }
    } else {
        Ok(SocketResponse {
            success: false,
            data: None,
            error: Some("No result in state dump response".to_string()),
        })
    }
}

/// Generate the JavaScript code to introspect application state
fn generate_state_dump_code(max_depth: usize, path: Option<String>) -> String {
    let path_str = path.unwrap_or_else(String::new);

    // Note: We use raw string with careful escaping to avoid double-brace issues
    let mut code = format!(
        r#"(async () => {{
    try {{
        const result = {{}};
        const errors = [];
        const libraries = [];
        const MAX_DEPTH = {};
        const MAX_SIZE = 1000000;
        let currentSize = 0;
        const seen = new WeakSet();

        function safeStringify(value, depth = 0) {{
            if (depth > MAX_DEPTH) return "[Max depth reached]";
            if (value === null) return null;
            if (value === undefined) return undefined;

            const type = typeof value;

            if (type !== 'object') {{
                if (type === 'function') return '[Function]';
                if (type === 'string') {{
                    if (value.length > 1000) return value.substring(0, 1000) + '[... truncated]';
                }}
                return value;
            }}

            if (seen.has(value)) return '[Circular Reference]';

            try {{
                const str = JSON.stringify(value);
                if (currentSize + str.length > MAX_SIZE) return '[Size limit exceeded]';
                currentSize += str.length;
            }} catch (e) {{}}

            try {{
                seen.add(value);
            }} catch (e) {{}}

            if (Array.isArray(value)) {{
                return value.map(item => safeStringify(item, depth + 1));
            }}

            if (value.constructor === Object || value.constructor === undefined) {{
                const result = {{}};
                const keys = Object.keys(value).slice(0, 100);
                for (const key of keys) {{
                    try {{
                        result[key] = safeStringify(value[key], depth + 1);
                    }} catch (e) {{
                        result[key] = '[Error: ' + e.message + ']';
                    }}
                }}
                if (Object.keys(value).length > 100) {{
                    result['[... more keys]'] = '[Truncated]';
                }}
                return result;
            }}

            if (value instanceof Map) {{
                const result = {{}};
                let count = 0;
                for (const [k, v] of value) {{
                    if (count >= 100) {{
                        result['[... more entries]'] = '[Truncated]';
                        break;
                    }}
                    result[String(k)] = safeStringify(v, depth + 1);
                    count++;
                }}
                return result;
            }}

            if (value instanceof Set) {{
                return Array.from(value).slice(0, 100).map(item => safeStringify(item, depth + 1));
            }}

            if (value instanceof Date) {{
                return value.toISOString();
            }}

            if (value instanceof RegExp) {{
                return {{
                    source: value.source,
                    flags: value.flags
                }};
            }}

            return '[Object ' + (value.constructor?.name || 'Unknown') + ']';
        }}

        function getByPath(obj, path) {{
            const parts = path.split('.');
            let current = obj;
            for (const part of parts) {{
                if (current == null) return undefined;
                current = current[part];
            }}
            return current;
        }}

        if (typeof window !== 'undefined' && window.__zustand_state) {{
            try {{
                libraries.push('zustand');
                const zustandState = Object.keys(window.__zustand_state).reduce((acc, key) => {{
                    try {{
                        const store = window.__zustand_state[key];
                        if (store && typeof store.getState === 'function') {{
                            acc[key] = safeStringify(store.getState(), 0);
                        }}
                    }} catch (e) {{
                        errors.push('zustand-' + key + ': ' + e.message);
                    }}
                    return acc;
                }}, {{}});
                if (Object.keys(zustandState).length > 0) {{
                    result.zustand = zustandState;
                }}
            }} catch (e) {{
                errors.push('zustand: ' + e.message);
            }}
        }}

        if (typeof window !== 'undefined' && window.__REDUX_DEVTOOLS_EXTENSION__) {{
            try {{
                libraries.push('redux');
                if (window.__store && typeof window.__store.getState === 'function') {{
                    result.redux = safeStringify(window.__store.getState(), 0);
                }}
            }} catch (e) {{
                errors.push('redux: ' + e.message);
            }}
        }}

        if (typeof window !== 'undefined' && window.__PINIA__) {{
            try {{
                libraries.push('pinia');
                const pinia = window.__PINIA__;
                const storeMap = {{}};
                if (pinia._s) {{
                    for (const [key, store] of pinia._s) {{
                        storeMap[key] = safeStringify(store.$state, 0);
                    }}
                }}
                if (Object.keys(storeMap).length > 0) {{
                    result.pinia = storeMap;
                }}
            }} catch (e) {{
                errors.push('pinia: ' + e.message);
            }}
        }}

        if (typeof window !== 'undefined' && window.__VUE__) {{
            try {{
                libraries.push('vue2');
                if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {{
                    const hook = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
                    if (hook.currentInstance) {{
                        const vm = hook.currentInstance;
                        if (vm && vm.$data) {{
                            result.vue = safeStringify(vm.$data, 0);
                        }}
                    }}
                }}
            }} catch (e) {{
                errors.push('vue: ' + e.message);
            }}
        }}

        if (typeof window !== 'undefined' && window.__RECOIL_INTERNAL_SNAPSHOT__) {{
            try {{
                libraries.push('recoil');
                result.recoil = safeStringify(window.__RECOIL_INTERNAL_SNAPSHOT__, 0);
            }} catch (e) {{
                errors.push('recoil: ' + e.message);
            }}
        }}

        if (typeof window !== 'undefined' && window.__mobxGlobalState) {{
            try {{
                libraries.push('mobx');
                result.mobx = safeStringify(window.__mobxGlobalState, 0);
            }} catch (e) {{
                errors.push('mobx: ' + e.message);
            }}
        }}

        let finalResult = result;
"#,
        max_depth
    );

    // Add path handling
    if !path_str.is_empty() {
        code.push_str(&format!(
            r#"        try {{
            const pathValue = getByPath(result, '{}');
            finalResult = {{}};
            finalResult['{}'] = safeStringify(pathValue, 0);
        }} catch (e) {{
            errors.push('path-filter: ' + e.message);
        }}
"#,
            path_str.replace("'", "\\'"),
            path_str.replace("'", "\\'")
        ));
    }

    code.push_str(
        r#"        const response = {
            state: finalResult,
            detected_libraries: libraries,
            metadata: {
                truncated: currentSize > MAX_SIZE,
                max_depth_reached: false,
                libraries_checked: ['zustand', 'redux', 'pinia', 'vue2', 'recoil', 'mobx'],
                serialization_errors: errors
            }
        };

        window.dispatchEvent(new CustomEvent('execute-js-response', {
            detail: {
                result: JSON.stringify(response),
                type: 'object'
            }
        }));
    } catch (error) {
        window.dispatchEvent(new CustomEvent('execute-js-response', {
            detail: {
                error: 'State dump error: ' + error.message,
                type: 'error'
            }
        }));
    }
})();"#
    );

    code
}
