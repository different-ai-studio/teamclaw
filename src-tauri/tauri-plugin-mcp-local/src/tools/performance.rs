use serde_json::{json, Value};
use tauri::{AppHandle, Runtime, Manager, Emitter, Listener};
use log::info;
use std::sync::mpsc;

use crate::error::Error;
use crate::socket_server::SocketResponse;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PerformanceMetricsRequest {
    window_label: Option<String>,
    include_navigation: Option<bool>,
    include_resources: Option<bool>,
    include_user_timing: Option<bool>,
    include_memory: Option<bool>,
    include_long_tasks: Option<bool>,
    resource_filter: Option<ResourceFilter>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ResourceFilter {
    resource_type: Option<Vec<String>>, // "script", "stylesheet", "image", "fetch", "xmlhttprequest", etc.
    min_duration_ms: Option<f64>,
    max_duration_ms: Option<f64>,
    #[allow(dead_code)]
    url_pattern: Option<String>,
}

pub async fn handle_get_performance_metrics<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: PerformanceMetricsRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for performance metrics: {}", e)))?;

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
    let js_code = generate_performance_metrics_code(
        request.include_navigation.unwrap_or(true),
        request.include_resources.unwrap_or(true),
        request.include_user_timing.unwrap_or(true),
        request.include_memory.unwrap_or(true),
        request.include_long_tasks.unwrap_or(false),
        request.resource_filter.clone(),
    );

    // Execute the JavaScript in the window
    let (tx, rx) = mpsc::channel();

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
    let timeout = std::time::Duration::from_millis(request.timeout_ms.unwrap_or(10000));
    let result_string = rx
        .recv_timeout(timeout)
        .map_err(|_| Error::timeout_error("performance metrics execution", request.timeout_ms.unwrap_or(10000)))?;

    // Parse the response
    let response_value: Value = serde_json::from_str(&result_string)
        .map_err(|e| Error::serialization_error(format!("Failed to parse performance metrics response: {}", e)))?;

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
            // Parse the metrics result
            match serde_json::from_str::<Value>(result_str) {
                Ok(metrics) => {
                    let data = serde_json::to_value(metrics)
                        .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;

                    info!("[TAURI_MCP] Performance metrics retrieved successfully");

                    Ok(SocketResponse {
                        success: true,
                        data: Some(data),
                        error: None,
                    })
                }
                Err(e) => {
                    info!("[TAURI_MCP] Failed to parse performance metrics result: {}", e);
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
                error: Some("Performance metrics result is not a string".to_string()),
            })
        }
    } else {
        Ok(SocketResponse {
            success: false,
            data: None,
            error: Some("No result in performance metrics response".to_string()),
        })
    }
}

/// Generate the JavaScript code to collect performance metrics
fn generate_performance_metrics_code(
    include_navigation: bool,
    include_resources: bool,
    include_user_timing: bool,
    include_memory: bool,
    include_long_tasks: bool,
    resource_filter: Option<ResourceFilter>,
) -> String {
    let mut code = String::from(
        r#"(async () => {
    try {
        const metrics = {};
        const errors = [];

        // Helper function to safely access performance entries
        function safeGetEntries(entryType) {
            try {
                if (typeof performance !== 'undefined' && performance.getEntriesByType) {
                    return performance.getEntriesByType(entryType);
                }
                return [];
            } catch (e) {
                errors.push(`Error getting ${entryType} entries: ${e.message}`);
                return [];
            }
        }

        // 1. Navigation Timing Data
"#,
    );

    if include_navigation {
        code.push_str(
            r#"        try {
            if (typeof performance !== 'undefined' && performance.timing) {
                const timing = performance.timing;
                const navigationStart = timing.navigationStart;

                metrics.navigation_timing = {
                    dns_lookup_ms: timing.domainLookupEnd - timing.domainLookupStart,
                    tcp_connection_ms: timing.connectEnd - timing.connectStart,
                    request_time_ms: timing.responseStart - timing.requestStart,
                    response_time_ms: timing.responseEnd - timing.responseStart,
                    dom_interactive_ms: timing.domInteractive - navigationStart,
                    dom_complete_ms: timing.domComplete - navigationStart,
                    page_load_ms: timing.loadEventEnd - navigationStart,
                    unload_ms: timing.unloadEventEnd - timing.unloadEventStart,
                    redirect_ms: timing.redirectEnd - timing.redirectStart,
                    total_page_load_ms: timing.loadEventEnd - navigationStart,
                    // Derived metrics
                    time_to_interactive_ms: timing.domInteractive - navigationStart,
                    first_paint_ms: typeof performance.getEntriesByName === 'function' ?
                        (() => {
                            try {
                                const paintEntries = performance.getEntriesByType('paint');
                                const firstPaint = paintEntries.find(p => p.name === 'first-paint');
                                return firstPaint ? firstPaint.startTime : null;
                            } catch (e) { return null; }
                        })() : null
                };

                // Check for PerformanceNavigationTiming (newer API)
                if (typeof PerformanceNavigationTiming !== 'undefined' && performance.getEntriesByType) {
                    try {
                        const navEntries = performance.getEntriesByType('navigation');
                        if (navEntries.length > 0) {
                            const navEntry = navEntries[0];
                            metrics.navigation_timing_v2 = {
                                transfer_size: navEntry.transferSize || 0,
                                encoded_body_size: navEntry.encodedBodySize || 0,
                                decoded_body_size: navEntry.decodedBodySize || 0,
                                server_timing: navEntry.serverTiming ? navEntry.serverTiming.map(st => ({
                                    name: st.name,
                                    duration: st.duration,
                                    description: st.description
                                })) : []
                            };
                        }
                    } catch (e) {
                        errors.push(`Error getting navigation timing v2: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            errors.push(`Error collecting navigation timing: ${e.message}`);
        }
"#,
        );
    }

    // 2. Resource Timing Data
    if include_resources {
        code.push_str(
            r#"        try {
            const resources = safeGetEntries('resource');
            if (resources.length > 0) {
                const resourcesByType = {};
                const allResources = [];

                resources.forEach(resource => {
                    const resourceType = resource.initiatorType || 'other';
"#,
        );

        // Add resource filtering logic if provided
        if let Some(filter) = resource_filter {
            if filter.resource_type.is_some() || filter.min_duration_ms.is_some() {
                code.push_str(
                    r#"
                    // Apply filters
                    const resourceTypeFilter = ["#,
                );

                if let Some(types) = filter.resource_type {
                    code.push_str(&format!(
                        "\"{}\"",
                        types.join("\", \"")
                    ));
                }

                code.push_str(
                    r#"];
                    const minDurationMs = "#,
                );

                if let Some(min_dur) = filter.min_duration_ms {
                    code.push_str(&min_dur.to_string());
                } else {
                    code.push_str("0");
                }

                code.push_str(
                    r#";
                    const maxDurationMs = "#,
                );

                if let Some(max_dur) = filter.max_duration_ms {
                    code.push_str(&max_dur.to_string());
                } else {
                    code.push_str("Infinity");
                }

                code.push_str(
                    r#";

                    if (resourceTypeFilter.length > 0 && !resourceTypeFilter.includes(resourceType)) {
                        return;
                    }

                    const duration = resource.responseEnd - resource.startTime;
                    if (duration < minDurationMs || duration > maxDurationMs) {
                        return;
                    }
"#,
                );
            }
        }

        code.push_str(
            r#"
                    if (!resourcesByType[resourceType]) {
                        resourcesByType[resourceType] = [];
                    }

                    const resourceEntry = {
                        name: resource.name,
                        type: resourceType,
                        start_time_ms: resource.startTime,
                        duration_ms: resource.responseEnd - resource.startTime,
                        transfer_size: resource.transferSize || 0,
                        encoded_body_size: resource.encodedBodySize || 0,
                        decoded_body_size: resource.decodedBodySize || 0,
                        cache_behavior: (resource.transferSize === 0 && resource.decodedBodySize > 0) ? 'cached' : 'network',
                        dns_lookup_ms: (resource.domainLookupEnd || 0) - (resource.domainLookupStart || 0),
                        tcp_connection_ms: (resource.connectEnd || 0) - (resource.connectStart || 0),
                        request_time_ms: (resource.responseStart || 0) - (resource.requestStart || 0),
                        response_time_ms: (resource.responseEnd || 0) - (resource.responseStart || 0)
                    };

                    resourcesByType[resourceType].push(resourceEntry);
                    allResources.push(resourceEntry);
                });

                metrics.resource_timing = {
                    by_type: resourcesByType,
                    summary: {
                        total_resources: allResources.length,
                        total_duration_ms: allResources.reduce((sum, r) => sum + r.duration_ms, 0),
                        largest_transfer_size_bytes: Math.max(...allResources.map(r => r.transfer_size), 0),
                        cached_resources: allResources.filter(r => r.cache_behavior === 'cached').length,
                        network_resources: allResources.filter(r => r.cache_behavior === 'network').length
                    },
                    resources: allResources.slice(0, 100) // Limit to first 100 for performance
                };
            }
        } catch (e) {
            errors.push(`Error collecting resource timing: ${e.message}`);
        }
"#,
        );
    }

    // 3. User Timing Marks and Measures
    if include_user_timing {
        code.push_str(
            r#"        try {
            const marks = safeGetEntries('mark');
            const measures = safeGetEntries('measure');

            if (marks.length > 0 || measures.length > 0) {
                metrics.user_timing = {
                    marks: marks.map(mark => ({
                        name: mark.name,
                        start_time_ms: mark.startTime,
                        duration_ms: 0,
                        detail: mark.detail || null
                    })).slice(0, 100),
                    measures: measures.map(measure => ({
                        name: measure.name,
                        start_time_ms: measure.startTime,
                        duration_ms: measure.duration,
                        detail: measure.detail || null
                    })).slice(0, 100)
                };
            }
        } catch (e) {
            errors.push(`Error collecting user timing: ${e.message}`);
        }
"#,
        );
    }

    // 4. Memory Usage
    if include_memory {
        code.push_str(
            r#"        try {
            if (typeof performance !== 'undefined' && performance.memory) {
                const memory = performance.memory;
                metrics.memory_usage = {
                    js_heap_size_limit_bytes: memory.jsHeapSizeLimit,
                    total_js_heap_size_bytes: memory.totalJSHeapSize,
                    used_js_heap_size_bytes: memory.usedJSHeapSize,
                    heap_usage_percent: (memory.usedJSHeapSize / memory.jsHeapSizeLimit * 100).toFixed(2),
                    available_bytes: memory.jsHeapSizeLimit - memory.usedJSHeapSize,
                    timestamp_ms: Date.now()
                };
            } else {
                metrics.memory_usage = { available: false, reason: 'performance.memory API not available' };
            }
        } catch (e) {
            errors.push(`Error collecting memory usage: ${e.message}`);
        }
"#,
        );
    }

    // 5. Long Tasks (tasks > 50ms)
    if include_long_tasks {
        code.push_str(
            r#"        try {
            if (typeof PerformanceObserver !== 'undefined') {
                // Note: Long Tasks API requires specific permissions, might not always work
                const longTasks = [];
                try {
                    const observer = new PerformanceObserver((list) => {
                        const entries = list.getEntries();
                        entries.forEach(entry => {
                            if (entry.duration > 50) {
                                longTasks.push({
                                    start_time_ms: entry.startTime,
                                    duration_ms: entry.duration,
                                    name: entry.name,
                                    attribution: entry.attribution ? entry.attribution.map(attr => ({
                                        name: attr.name,
                                        duration: attr.duration,
                                        start_time: attr.startTime
                                    })) : []
                                });
                            }
                        });
                    });
                    observer.observe({ entryTypes: ['longtask'] });

                    // Also get already recorded long tasks
                    const existingLongTasks = safeGetEntries('longtask');
                    if (existingLongTasks.length > 0) {
                        metrics.long_tasks = {
                            count: existingLongTasks.length,
                            tasks: existingLongTasks.filter(t => t.duration > 50).map(t => ({
                                start_time_ms: t.startTime,
                                duration_ms: t.duration,
                                name: t.name
                            })).slice(0, 50)
                        };
                    }
                } catch (e) {
                    // Long Tasks API not available - this is expected in many browsers
                    errors.push(`Long Tasks API unavailable: ${e.message}`);
                }
            }
        } catch (e) {
            errors.push(`Error collecting long tasks: ${e.message}`);
        }
"#,
        );
    }

    // 6. Paint Timing
    code.push_str(
        r#"        try {
            const paints = safeGetEntries('paint');
            if (paints.length > 0) {
                metrics.paint_timing = paints.map(paint => ({
                    name: paint.name,
                    start_time_ms: paint.startTime
                }));
            }
        } catch (e) {
            errors.push(`Error collecting paint timing: ${e.message}`);
        }

        // 7. Largest Contentful Paint (if available)
        try {
            if (typeof PerformanceObserver !== 'undefined') {
                let lcpValue = null;
                try {
                    const observer = new PerformanceObserver((entryList) => {
                        const entries = entryList.getEntries();
                        const lastEntry = entries[entries.length - 1];
                        lcpValue = {
                            name: lastEntry.name,
                            start_time_ms: lastEntry.startTime,
                            render_time_ms: lastEntry.renderTime || lastEntry.startTime,
                            load_time_ms: lastEntry.loadTime || lastEntry.startTime,
                            size: lastEntry.size || 0,
                            url: lastEntry.url || null,
                            element: lastEntry.element ? lastEntry.element.tagName : null
                        };
                    });
                    observer.observe({ type: 'largest-contentful-paint', buffered: true });

                    // Also try synchronous access
                    if (!lcpValue) {
                        const lcpEntries = safeGetEntries('largest-contentful-paint');
                        if (lcpEntries.length > 0) {
                            const lastLcp = lcpEntries[lcpEntries.length - 1];
                            lcpValue = {
                                name: lastLcp.name,
                                start_time_ms: lastLcp.startTime,
                                render_time_ms: lastLcp.renderTime || lastLcp.startTime,
                                load_time_ms: lastLcp.loadTime || lastLcp.startTime,
                                size: lastLcp.size || 0,
                                url: lastLcp.url || null,
                                element: lastLcp.element ? lastLcp.element.tagName : null
                            };
                        }
                    }

                    if (lcpValue) {
                        metrics.largest_contentful_paint = lcpValue;
                    }
                } catch (e) {
                    errors.push(`LCP API error: ${e.message}`);
                }
            }
        } catch (e) {
            errors.push(`Error collecting LCP: ${e.message}`);
        }

        // Final response
        const response = {
            metrics: metrics,
            collected_at_ms: Date.now(),
            errors: errors
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
                error: 'Performance metrics collection error: ' + error.message,
                type: 'error'
            }
        }));
    }
})();"#,
    );

    code
}
