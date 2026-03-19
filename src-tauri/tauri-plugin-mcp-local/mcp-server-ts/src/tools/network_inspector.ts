import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

// Define the HTTP methods
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"] as const;

// Define request types
const REQUEST_TYPES = ["fetch", "xhr"] as const;

// Define actions
const ACTIONS = ["get_requests", "clear_requests", "start_capture", "stop_capture"] as const;

export function registerNetworkInspectorTool(server: McpServer) {
  server.tool(
    "network_inspector",
    "Inspects and retrieves network requests (fetch/XHR) made by the application. Allows querying request/response headers, bodies, status codes, and timing information. Useful for debugging API integration issues and understanding network behavior.",
    {
      action: z.enum(ACTIONS).describe(
        "The action to perform: 'get_requests' to retrieve captured requests, 'clear_requests' to clear the capture buffer, 'start_capture' to start capturing, or 'stop_capture' to stop capturing."
      ),
      url_pattern: z.string().optional().describe("Optional. Filter requests by URL pattern (regex or substring match). Use to focus on specific endpoints."),
      method: z.enum(HTTP_METHODS).optional().describe("Optional. Filter requests by HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, TRACE, CONNECT)."),
      status_code: z.number().int().min(100).max(599).optional().describe("Optional. Filter requests by HTTP status code (e.g., 200, 404, 500)."),
      min_duration_ms: z.number().int().nonnegative().optional().describe("Optional. Only return requests that took at least this many milliseconds."),
      max_duration_ms: z.number().int().nonnegative().optional().describe("Optional. Only return requests that took at most this many milliseconds."),
      request_type: z.enum(REQUEST_TYPES).optional().describe("Optional. Filter by request type: 'fetch' for Fetch API or 'xhr' for XMLHttpRequest."),
      start_time_ms: z.number().int().nonnegative().optional().describe("Optional. Only return requests that started after this Unix timestamp in milliseconds."),
      end_time_ms: z.number().int().nonnegative().optional().describe("Optional. Only return requests that started before this Unix timestamp in milliseconds."),
      limit: z.number().int().positive().optional().describe("Optional. Maximum number of requests to return. Defaults to 100. Use for pagination."),
      window_label: z.string().optional().describe("Optional. The identifier of the application window to inspect. Defaults to 'main' if not specified."),
    },
    {
      title: "Inspect Network Requests from Application",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({
      action,
      url_pattern,
      method,
      status_code,
      min_duration_ms,
      max_duration_ms,
      request_type,
      start_time_ms,
      end_time_ms,
      limit,
      window_label,
    }) => {
      try {
        const params = {
          action,
          window_label: window_label || "main",
          filter: {
            url_pattern,
            method,
            status_code,
            min_duration_ms,
            max_duration_ms,
            request_type,
            start_time_ms,
            end_time_ms,
            limit: limit || 100,
          },
        };

        logCommandParams("network_inspector", params);

        const result = await socketClient.sendCommand("network_inspector", params);

        console.error(`Got network inspector result: ${typeof result}`);

        // Format the result for display
        if (typeof result === "object" && result && "requests" in result) {
          const requestsData = result as {
            requests: Array<{
              id: string;
              url: string;
              method: string;
              request_type: string;
              status_code?: number;
              request_headers: Record<string, string>;
              response_headers: Record<string, string>;
              request_body?: string;
              response_body?: string;
              error?: string;
              start_time_ms: number;
              end_time_ms?: number;
              duration_ms?: number;
            }>;
            total_count: number;
            returned_count: number;
            capture_active: boolean;
          };

          if (requestsData.requests.length === 0) {
            return createSuccessResponse("No network requests found matching the specified criteria.");
          }

          // Format requests for display
          const formattedRequests = requestsData.requests
            .map((req) => {
              const time = new Date(req.start_time_ms).toISOString();
              const duration = req.duration_ms ? `${req.duration_ms}ms` : "pending";
              const status = req.status_code ? `[${req.status_code}]` : "[pending]";
              const type = req.request_type.toUpperCase();

              let summary = `[${time}] ${req.method.padEnd(7)} ${status} (${type}, ${duration}) ${req.url}`;

              if (req.error) {
                summary += `\n    ERROR: ${req.error}`;
              }

              if (req.request_body) {
                const bodyPreview = req.request_body.substring(0, 100);
                const truncated = req.request_body.length > 100 ? "..." : "";
                summary += `\n    Request: ${bodyPreview}${truncated}`;
              }

              if (req.response_body) {
                const bodyPreview = req.response_body.substring(0, 100);
                const truncated = req.response_body.length > 100 ? "..." : "";
                summary += `\n    Response: ${bodyPreview}${truncated}`;
              }

              // Show relevant headers
              const relevantHeaders = ["content-type", "content-length", "authorization", "x-request-id"];
              const displayHeaders = relevantHeaders.filter(
                (h) => req.request_headers[h] || req.response_headers[h]
              );

              if (displayHeaders.length > 0) {
                summary += "\n    Headers:";
                displayHeaders.forEach((h) => {
                  const req_val = req.request_headers[h];
                  const resp_val = req.response_headers[h];
                  if (req_val) summary += ` ${h}: ${req_val};`;
                  if (resp_val && resp_val !== req_val) summary += ` ${h}: ${resp_val};`;
                });
              }

              return summary;
            })
            .join("\n\n");

          const captureStatus = requestsData.capture_active ? "ACTIVE" : "INACTIVE";
          const summary = `Network Requests (${requestsData.returned_count} of ${requestsData.total_count} total) [Capture: ${captureStatus}]\n\n${formattedRequests}`;
          return createSuccessResponse(summary);
        }

        return createSuccessResponse(formatResultAsText(result));
      } catch (error) {
        console.error("Network inspector error:", error);
        return createErrorResponse(`Failed to inspect network requests: ${(error as Error).message}`);
      }
    }
  );
}

export function registerInjectNetworkCaptureTool(server: McpServer) {
  server.tool(
    "inject_network_capture",
    "Injects the network capture script into the webview to start intercepting fetch and XMLHttpRequest (XHR) calls. This must be called once when the application starts to enable network request inspection. Subsequent calls re-inject the capture mechanism.",
    {
      window_label: z.string().optional().describe("Optional. The identifier of the application window to inject the capture script into. Defaults to 'main' if not specified."),
    },
    {
      title: "Inject Network Capture Script into Webview",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label }) => {
      try {
        const params = {
          window_label: window_label || "main",
        };

        logCommandParams("inject_network_capture", params);

        const result = await socketClient.sendCommand("inject_network_capture", params);

        console.error(`Network capture injection result: ${typeof result}`);

        return createSuccessResponse(
          "Network capture script successfully injected. Fetch and XHR requests will now be captured."
        );
      } catch (error) {
        console.error("Network capture injection error:", error);
        return createErrorResponse(`Failed to inject network capture script: ${(error as Error).message}`);
      }
    }
  );
}
