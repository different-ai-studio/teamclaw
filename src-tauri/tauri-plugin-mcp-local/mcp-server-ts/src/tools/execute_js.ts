import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

export function registerExecuteJsTool(server: McpServer) {
  server.tool(
    "execute_js",
    "Executes arbitrary JavaScript code within the context of a specified application window's webview (e.g., a Tauri webview). Returns the result of the last executed statement or a promise resolution. Caution: This tool is destructive and can modify the window's content, state, or trigger unintended actions. Use with careful consideration of the code being executed.",
    {
      code: z.string().describe("Required. The string of JavaScript code to be executed in the target window's webview context. Ensure the code is safe and achieves the intended purpose. Malformed or malicious code can lead to errors or unwanted behavior."),
      window_label: z.string().default("main").describe("The identifier (e.g., visible title or internal label) of the application window where the JavaScript code will be executed. Defaults to 'main' if not specified."),
      timeout_ms: z.number().int().positive().optional().describe("The maximum time in milliseconds to allow for the JavaScript execution. If the script exceeds this timeout, its execution will be terminated, and an error may be returned."),
    },
    {
      title: "Execute JavaScript Code in Specified Application Window",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ code, window_label, timeout_ms }) => {
      try {
        // Validate required parameters
        if (!code || code.trim() === '') {
          return createErrorResponse("The code parameter is required and cannot be empty");
        }
        
        const params = { code, window_label, timeout_ms };
        logCommandParams('execute_js', params);
        
        // Use default window label if not provided
        const effectiveWindowLabel = window_label || 'main';
        
        const result = await socketClient.sendCommand('execute_js', {
          code,
          window_label: effectiveWindowLabel,
          timeout_ms
        });
        
        console.error(`Got JS execution result type: ${typeof result}`);
        
        return createSuccessResponse(formatResultAsText(result));
      } catch (error) {
        console.error('JS execution error:', error);
        return createErrorResponse(`Failed to execute JavaScript: ${(error as Error).message}`);
      }
    },
  );
} 