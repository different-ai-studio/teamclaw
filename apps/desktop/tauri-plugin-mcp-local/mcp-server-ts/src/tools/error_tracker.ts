import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

// Define the error types
const ERROR_TYPES = ["uncaught", "unhandledrejection", "reactboundary", "all"] as const;

export function registerGetExceptionsTool(server: McpServer) {
  server.tool(
    "get_exceptions",
    "Retrieves unhandled exceptions, unhandled promise rejections, and React error boundary catches from the application. Includes full stack traces with source map resolution, error frequency tracking, and first/last occurrence timestamps. Allows filtering by error type, message pattern, and time range. Useful for debugging application crashes and errors.",
    {
      error_type: z.enum(ERROR_TYPES).optional().describe("Optional. Filter exceptions by type: 'uncaught' (unhandled exceptions), 'unhandledrejection' (unhandled promise rejections), 'reactboundary' (React error boundaries), or 'all' (default). Use 'all' or omit to get all error types."),
      message_pattern: z.string().optional().describe("Optional. Filter exceptions by message pattern (case-insensitive substring match). Useful for finding specific error messages."),
      start_time_ms: z.number().int().nonnegative().optional().describe("Optional. Only return exceptions after this Unix timestamp in milliseconds. Use for time range filtering."),
      end_time_ms: z.number().int().nonnegative().optional().describe("Optional. Only return exceptions before this Unix timestamp in milliseconds. Use for time range filtering."),
      limit: z.number().int().positive().optional().describe("Optional. Maximum number of exception entries to return. Defaults to 1000. Use for pagination or limiting output size."),
      window_label: z.string().optional().describe("Optional. The identifier of the application window to retrieve exceptions from. Defaults to 'main' if not specified."),
    },
    {
      title: "Get Unhandled Exceptions and Error Boundaries from Application",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ error_type, message_pattern, start_time_ms, end_time_ms, limit, window_label }) => {
      try {
        const params = {
          error_type: error_type || "all",
          message_pattern,
          start_time_ms,
          end_time_ms,
          limit: limit || 1000,
          window_label: window_label || "main"
        };

        logCommandParams('get_exceptions', params);

        const result = await socketClient.sendCommand('get_exceptions', {
          error_type: params.error_type,
          message_pattern: params.message_pattern,
          start_time_ms: params.start_time_ms,
          end_time_ms: params.end_time_ms,
          limit: params.limit,
          window_label: params.window_label
        });

        console.error(`Got exceptions result: ${typeof result}`);

        // Format the result as text for display
        if (typeof result === 'object' && result && 'exceptions' in result) {
          const exceptionsData = result as { exceptions: Array<{ id: string; error_type: string; message: string; stack_trace: any[]; first_occurrence_ms: number; last_occurrence_ms: number; frequency: number }>; total_count: number; returned_count: number };

          if (exceptionsData.exceptions.length === 0) {
            return createSuccessResponse("No exceptions found matching the specified criteria.");
          }

          // Format exceptions for display
          const formattedExceptions = exceptionsData.exceptions
            .map(exc => {
              const firstOccurrence = new Date(exc.first_occurrence_ms).toISOString();
              const lastOccurrence = new Date(exc.last_occurrence_ms).toISOString();
              const type = exc.error_type.toUpperCase().padEnd(20);
              const frequency = `(${exc.frequency}x)`;
              const stackPreview = exc.stack_trace.length > 0
                ? `\n    at ${exc.stack_trace[0].function_name || 'anonymous'} (${exc.stack_trace[0].file_name || 'unknown'}:${exc.stack_trace[0].line_number || '?'})`
                : '';
              return `ID: ${exc.id}\nType: ${type} ${frequency}\nMessage: ${exc.message}\nFirst: ${firstOccurrence}\nLast: ${lastOccurrence}${stackPreview}\n`;
            })
            .join('\n---\n');

          const summary = `Exceptions (${exceptionsData.returned_count} of ${exceptionsData.total_count} total)\n\n${formattedExceptions}`;
          return createSuccessResponse(summary);
        }

        return createSuccessResponse(formatResultAsText(result));
      } catch (error) {
        console.error('Exception retrieval error:', error);
        return createErrorResponse(`Failed to retrieve exceptions: ${(error as Error).message}`);
      }
    },
  );
}

export function registerInjectErrorTrackerTool(server: McpServer) {
  server.tool(
    "inject_error_tracker",
    "Injects the error tracking script into the webview to start capturing unhandled exceptions via window.onerror, unhandled promise rejections via unhandledrejection event, and React error boundaries. This must be called once when the application starts to enable exception retrieval. The script uses a circular buffer to prevent unbounded memory growth. Subsequent calls re-inject the tracking mechanism.",
    {
      window_label: z.string().optional().describe("Optional. The identifier of the application window to inject the tracking script into. Defaults to 'main' if not specified."),
      circular_buffer_size: z.number().int().positive().optional().describe("Optional. Maximum number of exceptions to store in the circular buffer. Defaults to 1000. Older exceptions are discarded when the buffer is full."),
    },
    {
      title: "Inject Error Tracking Script into Webview",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label, circular_buffer_size }) => {
      try {
        const params = {
          window_label: window_label || "main",
          circular_buffer_size: circular_buffer_size || 1000
        };

        logCommandParams('inject_error_tracker', params);

        const result = await socketClient.sendCommand('inject_error_tracker', {
          window_label: params.window_label,
          circular_buffer_size: params.circular_buffer_size
        });

        console.error(`Error tracker injection result: ${typeof result}`);

        return createSuccessResponse(`Error tracking script successfully injected with buffer size ${params.circular_buffer_size}. Exceptions will now be captured.`);
      } catch (error) {
        console.error('Error tracker injection error:', error);
        return createErrorResponse(`Failed to inject error tracking script: ${(error as Error).message}`);
      }
    },
  );
}

export function registerClearExceptionsTool(server: McpServer) {
  server.tool(
    "clear_exceptions",
    "Clears all tracked exceptions from the circular buffer in the webview. This resets the exception tracking to a clean state. Useful for testing or clearing out old errors after diagnosis.",
    {
      window_label: z.string().optional().describe("Optional. The identifier of the application window to clear exceptions from. Defaults to 'main' if not specified."),
    },
    {
      title: "Clear All Tracked Exceptions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label }) => {
      try {
        const params = {
          window_label: window_label || "main"
        };

        logCommandParams('clear_exceptions', params);

        const result = await socketClient.sendCommand('clear_exceptions', {
          window_label: params.window_label
        });

        console.error(`Clear exceptions result: ${typeof result}`);

        return createSuccessResponse("All exceptions have been cleared from the tracking buffer.");
      } catch (error) {
        console.error('Clear exceptions error:', error);
        return createErrorResponse(`Failed to clear exceptions: ${(error as Error).message}`);
      }
    },
  );
}
