import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";

export function registerManageLocalStorageTool(server: McpServer) {
  server.tool(
    "manage_local_storage",
    "Allows reading from or modifying the browser's localStorage data associated with a specified application window's webview (e.g., a Tauri webview). Supports getting, setting, removing items, clearing all items, or listing keys. Some actions are destructive.",
    {
      action: z.enum(["get", "set", "remove", "clear", "keys"]).describe("Required. The operation to perform on localStorage. Valid values are: \n - get: Retrieve the value of a specified key. \n - set: Store a key-value pair. \n - remove: Delete a specified key and its value. \n - clear: Remove all key-value pairs. \n - keys: Retrieve a list of all keys currently stored."),
      key: z.string().optional().describe("The key (name) of the localStorage item to operate on. Required for 'get', 'set', and 'remove' actions. Ignored for 'clear' and 'keys' actions."),
      value: z.string().optional().describe("The string value to store in localStorage. Required only for the 'set' action. Ignored for other actions."),
      window_label: z.string().optional().describe("The identifier (e.g., visible title or internal label) of the application window whose localStorage is to be managed."),
    },
    {
      title: "Manage Browser LocalStorage for Application Window",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ action, key, value, window_label }) => {
      try {
        // Validate required parameters
        if (!action) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "The action parameter is required (get, set, remove, clear, or keys)",
              },
            ],
          };
        }
        
        // Validate actions that require a key
        if ((action === 'set' || action === 'remove') && !key) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `The key parameter is required for the '${action}' action`,
              },
            ],
          };
        }
        
        // Validate set action requires a value
        if (action === 'set' && value === undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "The value parameter is required for the 'set' action",
              },
            ],
          };
        }
        
        // Use default window label if not provided
        const effectiveWindowLabel = window_label || 'main';
        
        console.error(`Managing localStorage with params: ${JSON.stringify({
          action,
          key,
          value: value?.substring(0, 50) + (value && value.length > 50 ? '...' : ''),
          window_label: effectiveWindowLabel
        })}`);
        
        const result = await socketClient.sendCommand('manage_local_storage', {
          action,
          key,
          value,
          window_label: effectiveWindowLabel
        });
        
        console.error(`Got localStorage result type: ${typeof result}`);
        
        // Format the result as a string based on the type
        let resultText;
        if (typeof result === 'string') {
          resultText = result;
        } else if (Array.isArray(result)) {
          resultText = JSON.stringify(result);
        } else if (result === null || result === undefined) {
          resultText = String(result);
        } else {
          resultText = JSON.stringify(result, null, 2);
        }
        
        return {
          content: [
            {
              type: "text",
              text: resultText,
            },
          ],
        };
      } catch (error) {
        console.error('localStorage management error:', error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to manage localStorage: ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
} 