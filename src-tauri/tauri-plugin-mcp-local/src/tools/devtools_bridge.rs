use serde_json::{json, Value};
use tauri::{AppHandle, Runtime, Manager, Emitter, Listener};
use log::info;

use crate::error::Error;
use crate::socket_server::SocketResponse;

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DevToolsBridgeRequest {
    window_label: Option<String>,
    max_depth: Option<usize>,
    component_filter: Option<String>,
    timeout_ms: Option<u64>,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DevToolsBridgeResponse {
    framework: FrameworkInfo,
    components: Vec<ComponentInfo>,
    metadata: DevToolsMetadata,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct FrameworkInfo {
    framework_type: String,  // "react", "vue", "both", "none"
    react_version: Option<String>,
    vue_version: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ComponentInfo {
    name: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    props: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hooks: Option<Vec<HookInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<ComponentInfo>>,
    depth: usize,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct HookInfo {
    hook_name: String,
    hook_value: Value,
}

#[allow(dead_code)]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DevToolsMetadata {
    max_depth_reached: bool,
    total_components: usize,
    truncated: bool,
    errors: Vec<String>,
}

pub async fn handle_devtools_bridge<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: DevToolsBridgeRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for devtools_bridge: {}", e)))?;

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
    let js_code = generate_devtools_bridge_code(
        request.max_depth.unwrap_or(10),
        request.component_filter.clone(),
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
        .map_err(|_| Error::timeout_error("devtools bridge execution", request.timeout_ms.unwrap_or(5000)))?;

    // Parse the response
    let response_value: Value = serde_json::from_str(&result_string)
        .map_err(|e| Error::serialization_error(format!("Failed to parse devtools response: {}", e)))?;

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
            // Parse the devtools result
            match serde_json::from_str::<Value>(result_str) {
                Ok(bridge_data) => {
                    let data = serde_json::to_value(bridge_data)
                        .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;

                    Ok(SocketResponse {
                        success: true,
                        data: Some(data),
                        error: None,
                    })
                }
                Err(e) => {
                    // If parsing fails, return the raw result
                    info!("[TAURI_MCP] Failed to parse devtools result: {}", e);
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
                error: Some("DevTools result is not a string".to_string()),
            })
        }
    } else {
        Ok(SocketResponse {
            success: false,
            data: None,
            error: Some("No result in devtools response".to_string()),
        })
    }
}

/// Generate the JavaScript code to access React/Vue DevTools
fn generate_devtools_bridge_code(max_depth: usize, component_filter: Option<String>) -> String {
    let filter_value = component_filter
        .unwrap_or_default()
        .replace("'", "\\'");

    let code = format!(
        r#"(async () => {{
    try {{
        const result = {{}};
        const errors = [];
        const MAX_DEPTH = {0};
        let componentCount = 0;
        const seen = new WeakSet();
        const FILTER = '{1}';

        // Detect framework
        let reactHook = undefined;
        let vueHook = undefined;
        let vueVersion = undefined;
        let reactVersion = undefined;

        if (typeof window !== 'undefined') {{
            // Detect React and DevTools hook
            if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {{
                reactHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
                if (window.React && window.React.version) {{
                    reactVersion = window.React.version;
                }}
            }}

            // Detect Vue and DevTools hook
            if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {{
                vueHook = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
                if (window.__VUE__) {{
                    vueVersion = window.__VUE__.version;
                }}
            }}
        }}

        function safeStringify(value, depth = 0) {{
            if (depth > MAX_DEPTH) return "[Max depth reached]";
            if (value === null) return null;
            if (value === undefined) return undefined;

            const type = typeof value;

            if (type !== 'object') {{
                if (type === 'function') return '[Function]';
                if (type === 'string') {{
                    if (value.length > 500) return value.substring(0, 500) + '[... truncated]';
                }}
                if (type === 'symbol') return '[Symbol]';
                return value;
            }}

            if (seen.has(value)) return '[Circular Reference]';

            try {{
                seen.add(value);
            }} catch (e) {{}}

            if (Array.isArray(value)) {{
                const items = [];
                for (let i = 0; i < Math.min(value.length, 50); i++) {{
                    items.push(safeStringify(value[i], depth + 1));
                }}
                if (value.length > 50) {{
                    items.push('[... ' + String(value.length - 50) + ' more items]');
                }}
                return items;
            }}

            if (value instanceof Map) {{
                const result = {{}};
                let count = 0;
                for (const [k, v] of value) {{
                    if (count >= 30) {{
                        result['[... more entries]'] = '[Truncated]';
                        break;
                    }}
                    result[String(k)] = safeStringify(v, depth + 1);
                    count++;
                }}
                return result;
            }}

            if (value instanceof Set) {{
                const items = [];
                let count = 0;
                for (const item of value) {{
                    if (count >= 30) {{
                        items.push('[... ' + String(value.size - 30) + ' more items]');
                        break;
                    }}
                    items.push(safeStringify(item, depth + 1));
                    count++;
                }}
                return items;
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

            // Generic object
            if (value.constructor === Object || value.constructor === undefined) {{
                const obj = {{}};
                const keys = Object.keys(value).slice(0, 50);
                for (const key of keys) {{
                    try {{
                        obj[key] = safeStringify(value[key], depth + 1);
                    }} catch (e) {{
                        obj[key] = '[Error: ' + e.message + ']';
                    }}
                }}
                if (Object.keys(value).length > 50) {{
                    obj['[... more keys]'] = '[Truncated]';
                }}
                return obj;
            }}

            return '[Object ' + (value.constructor?.name || 'Unknown') + ']';
        }}

        function extractComponentInfo(component, depth) {{
            if (depth > MAX_DEPTH) return null;
            if (componentCount > 500) return null;

            // Apply filter if specified
            if (FILTER && !component.name.includes(FILTER)) {{
                return null;
            }}

            componentCount++;

            const info = {{
                name: component.name || 'Anonymous',
                id: String(component.id || Math.random()),
                depth: depth
            }};

            // Try to extract props
            if (component.memoizedProps) {{
                try {{
                    info.props = safeStringify(component.memoizedProps, depth + 1);
                }} catch (e) {{
                    errors.push('props extraction: ' + e.message);
                }}
            }}

            // Try to extract state (hooks)
            if (component.memoizedState) {{
                try {{
                    const hooks = [];
                    let hookState = component.memoizedState;
                    let hookIndex = 0;

                    while (hookState && hookIndex < 20) {{
                        const hookValue = hookState.memoizedState || hookState;
                        const hookName = getHookName(hookIndex);

                        hooks.push({{
                            hook_name: hookName,
                            hook_value: safeStringify(hookValue, depth + 2)
                        }});

                        hookState = hookState.next;
                        hookIndex++;
                    }}

                    if (hooks.length > 0) {{
                        info.hooks = hooks;
                    }}
                }} catch (e) {{
                    errors.push('hooks extraction: ' + e.message);
                }}
            }}

            // Extract state for class components
            if (component.state && component.memoizedProps) {{
                try {{
                    info.state = safeStringify(component.state, depth + 1);
                }} catch (e) {{
                    errors.push('class state extraction: ' + e.message);
                }}
            }}

            return info;
        }}

        function getHookName(index) {{
            const hookNames = ['useState', 'useReducer', 'useContext', 'useEffect', 'useLayoutEffect',
                              'useInsertionEffect', 'useRef', 'useImperativeHandle', 'useCallback', 'useMemo',
                              'useTransition', 'useDeferredValue', 'useSyncExternalStore', 'useId'];
            return hookNames[index] || 'useCustom_' + index;
        }}

        function traverseReactTree(fiber, depth, components) {{
            if (!fiber || depth > MAX_DEPTH || componentCount > 500) return;

            // Extract component info if this is a component fiber
            if (fiber.elementType && typeof fiber.elementType === 'function') {{
                const componentInfo = extractComponentInfo(fiber, depth);
                if (componentInfo) {{
                    components.push(componentInfo);
                }}
            }}

            // Traverse children
            if (fiber.child) {{
                traverseReactTree(fiber.child, depth + 1, components);
            }}

            // Traverse siblings
            if (fiber.sibling) {{
                traverseReactTree(fiber.sibling, depth, components);
            }}
        }}

        // Extract React component tree
        if (reactHook) {{
            try {{
                const components = [];
                if (reactHook.currentFiber) {{
                    traverseReactTree(reactHook.currentFiber, 0, components);
                }} else if (reactHook.renderers && reactHook.renderers.size > 0) {{
                    for (const renderer of reactHook.renderers.values()) {{
                        if (renderer.currentFiber) {{
                            traverseReactTree(renderer.currentFiber, 0, components);
                        }}
                    }}
                }}

                if (components.length > 0) {{
                    result.react_components = components;
                }}
            }} catch (e) {{
                errors.push('React extraction: ' + e.message);
            }}
        }}

        // Extract Vue component tree
        if (vueHook) {{
            try {{
                const components = [];
                if (vueHook.currentInstance) {{
                    const walkVueTree = (instance, depth) => {{
                        if (!instance || depth > MAX_DEPTH || componentCount > 500) return;

                        const componentName = instance.$options.name || instance.$options.__name || 'Component';

                        // Apply filter
                        if (FILTER && !componentName.includes(FILTER)) {{
                            return;
                        }}

                        componentCount++;

                        const info = {{
                            name: componentName,
                            id: String(instance.$.uid),
                            depth: depth
                        }};

                        // Extract props
                        if (instance.$props) {{
                            info.props = safeStringify(instance.$props, depth + 1);
                        }}

                        // Extract state (reactive data)
                        if (instance.$data) {{
                            info.state = safeStringify(instance.$data, depth + 1);
                        }}

                        // Extract computed properties
                        if (instance.$computed) {{
                            const computed = {{}};
                            for (const [key, value] of Object.entries(instance.$computed)) {{
                                computed[key] = safeStringify(value, depth + 2);
                            }}
                            if (Object.keys(computed).length > 0) {{
                                info.computed = computed;
                            }}
                        }}

                        components.push(info);

                        // Walk children
                        if (instance.$children) {{
                            for (const child of instance.$children) {{
                                walkVueTree(child, depth + 1);
                            }}
                        }}
                    }};

                    walkVueTree(vueHook.currentInstance, 0);

                    if (components.length > 0) {{
                        result.vue_components = components;
                    }}
                }}
            }} catch (e) {{
                errors.push('Vue extraction: ' + e.message);
            }}
        }}

        // Build response
        const response = {{
            framework: {{
                framework_type: reactHook && vueHook ? 'both' : (reactHook ? 'react' : (vueHook ? 'vue' : 'none')),
                react_version: reactVersion || null,
                vue_version: vueVersion || null
            }},
            components: result.react_components || result.vue_components || [],
            metadata: {{
                max_depth_reached: componentCount > 500,
                total_components: componentCount,
                truncated: componentCount > 500,
                errors: errors
            }}
        }};

        window.dispatchEvent(new CustomEvent('execute-js-response', {{
            detail: {{
                result: JSON.stringify(response),
                type: 'object'
            }}
        }}));
    }} catch (error) {{
        window.dispatchEvent(new CustomEvent('execute-js-response', {{
            detail: {{
                error: 'DevTools bridge error: ' + error.message,
                type: 'error'
            }}
        }}));
    }}
}})();"#,
        max_depth,
        filter_value
    );

    code
}
