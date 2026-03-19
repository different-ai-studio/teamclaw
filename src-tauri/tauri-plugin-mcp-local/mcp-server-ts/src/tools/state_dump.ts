import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

export function registerStateDumpTool(server: McpServer) {
  server.tool(
    "dump_application_state",
    "Retrieves and introspects the application state from supported state management libraries (Zustand, Redux, Pinia, Vue, Recoil, MobX). Detects which libraries are available in the webview context and returns their state in a structured JSON format. Handles circular references, non-serializable data, and large state trees gracefully.",
    {
      window_label: z.string().default("main").describe("The identifier (e.g., visible title or internal label) of the application window from which to retrieve state. Defaults to 'main' if not specified."),
      max_depth: z.number().int().positive().default(10).describe("Maximum depth for recursive state traversal. Prevents infinite recursion and truncates very deep nested structures. Defaults to 10."),
      path: z.string().optional().describe("Optional dot-notation path to a specific portion of state (e.g., 'zustand.userStore.profile'). If provided, only that portion of state is returned."),
      timeout_ms: z.number().int().positive().optional().describe("Maximum time in milliseconds to wait for the state dump operation to complete. Defaults to 5000ms if not specified."),
    },
    {
      title: "Dump Application State from State Management Libraries",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, max_depth, path, timeout_ms }) => {
      try {
        const params = { window_label, max_depth, path, timeout_ms };
        logCommandParams('dump_application_state', params);

        const effectiveWindowLabel = window_label || 'main';

        const result = await socketClient.sendCommand('state_dump', {
          window_label: effectiveWindowLabel,
          max_depth: max_depth || 10,
          path,
          timeout_ms: timeout_ms || 5000
        });

        console.error(`Got state dump result type: ${typeof result}`);

        // Format the result for output
        let formattedOutput = '';

        if (result && typeof result === 'object') {
          const { state, detected_libraries, metadata } = result as any;

          // Build the output text
          formattedOutput += `# Application State Dump\n\n`;

          // Detected libraries section
          if (detected_libraries && detected_libraries.length > 0) {
            formattedOutput += `## Detected Libraries\n`;
            formattedOutput += `Found: ${detected_libraries.join(', ')}\n\n`;
          }

          // Metadata section
          if (metadata) {
            formattedOutput += `## Metadata\n`;
            formattedOutput += `- Truncated: ${metadata.truncated || false}\n`;
            formattedOutput += `- Max Depth Reached: ${metadata.max_depth_reached || false}\n`;
            if (metadata.serialization_errors && metadata.serialization_errors.length > 0) {
              formattedOutput += `- Serialization Errors:\n`;
              metadata.serialization_errors.forEach((error: string) => {
                formattedOutput += `  - ${error}\n`;
              });
            }
            formattedOutput += `\n`;
          }

          // State section
          if (state) {
            formattedOutput += `## State Content\n\n`;
            formattedOutput += '```json\n';
            formattedOutput += JSON.stringify(state, null, 2);
            formattedOutput += '\n```\n';
          }

          return createSuccessResponse(formattedOutput);
        } else {
          return createSuccessResponse(formatResultAsText(result));
        }
      } catch (error) {
        console.error('State dump error:', error);
        return createErrorResponse(`Failed to dump application state: ${(error as Error).message}`);
      }
    },
  );
}
