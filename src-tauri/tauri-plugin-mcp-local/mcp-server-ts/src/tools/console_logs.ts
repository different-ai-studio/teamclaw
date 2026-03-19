import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

// Define the log levels
const LOG_LEVELS = ["debug", "info", "warn", "error", "all"] as const;

export function registerConsoleLogsTool(server: McpServer) {
  server.tool(
    "get_console_logs",
    "Retrieves console output messages (console.log, console.error, console.warn, console.info, console.debug) captured from the webview. Allows filtering by log level and time range. Useful for debugging and monitoring runtime behavior of the application.",
    {
      level: z.enum(LOG_LEVELS).optional().describe("Optional. Filter logs by level: 'debug', 'info', 'warn', 'error', or 'all' (default). Use 'all' or omit to get all log levels."),
      start_time_ms: z.number().int().nonnegative().optional().describe("Optional. Only return logs after this Unix timestamp in milliseconds. Use for time range filtering."),
      end_time_ms: z.number().int().nonnegative().optional().describe("Optional. Only return logs before this Unix timestamp in milliseconds. Use for time range filtering."),
      limit: z.number().int().positive().optional().describe("Optional. Maximum number of log entries to return. Defaults to 1000. Use for pagination or limiting output size."),
      window_label: z.string().optional().describe("Optional. The identifier of the application window to retrieve logs from. Defaults to 'main' if not specified."),
    },
    {
      title: "Get Console Logs from Application Webview",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ level, start_time_ms, end_time_ms, limit, window_label }) => {
      try {
        const params = {
          level: level || "all",
          start_time_ms,
          end_time_ms,
          limit: limit || 1000,
          window_label: window_label || "main"
        };

        logCommandParams('get_console_logs', params);

        const result = await socketClient.sendCommand('get_console_logs', {
          level: params.level,
          start_time_ms: params.start_time_ms,
          end_time_ms: params.end_time_ms,
          limit: params.limit,
          window_label: params.window_label
        });

        console.error(`Got console logs result: ${typeof result}`);

        // Format the result as text for display
        if (typeof result === 'object' && result && 'logs' in result) {
          const logsData = result as { logs: Array<{ timestamp: number; level: string; message: string; args: string[] }>; total_count: number; returned_count: number };

          if (logsData.logs.length === 0) {
            return createSuccessResponse("No console logs found matching the specified criteria.");
          }

          // Format logs for display
          const formattedLogs = logsData.logs
            .map(log => {
              const time = new Date(log.timestamp).toISOString();
              const level = log.level.toUpperCase().padEnd(6);
              const args = log.args.length > 0 ? ` ${log.args.join(', ')}` : '';
              return `[${time}] ${level} ${log.message}${args}`;
            })
            .join('\n');

          const summary = `Console Logs (${logsData.returned_count} of ${logsData.total_count} total)\n\n${formattedLogs}`;
          return createSuccessResponse(summary);
        }

        return createSuccessResponse(formatResultAsText(result));
      } catch (error) {
        console.error('Console logs retrieval error:', error);
        return createErrorResponse(`Failed to retrieve console logs: ${(error as Error).message}`);
      }
    },
  );
}

export function registerInjectConsoleCaptureTool(server: McpServer) {
  server.tool(
    "inject_console_capture",
    "Injects the console capture script into the webview to start capturing console.log, console.error, console.warn, console.info, and console.debug calls. This must be called once when the application starts to enable console log retrieval. Subsequent calls re-inject the capture mechanism.",
    {
      window_label: z.string().optional().describe("Optional. The identifier of the application window to inject the capture script into. Defaults to 'main' if not specified."),
    },
    {
      title: "Inject Console Capture Script into Webview",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label }) => {
      try {
        const params = {
          window_label: window_label || "main"
        };

        logCommandParams('inject_console_capture', params);

        const result = await socketClient.sendCommand('inject_console_capture', {
          window_label: params.window_label
        });

        console.error(`Console capture injection result: ${typeof result}`);

        return createSuccessResponse("Console capture script successfully injected. Console logs will now be captured.");
      } catch (error) {
        console.error('Console capture injection error:', error);
        return createErrorResponse(`Failed to inject console capture script: ${(error as Error).message}`);
      }
    },
  );
}
