import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";

export function registerSendTextToElementTool(server: McpServer) {
  server.tool(
    "send_text_to_element",
    "Finds an HTML element by selector and sends text input to it, suitable for inputs, textareas, and contentEditable elements. Note: While this tool updates DOM content, it may not trigger React state updates in applications using React - visual changes appear but application state may not reflect the changes.",
    {
      selector_type: z.enum(["id", "class", "tag", "text"]).describe("The type of selector to use: 'id', 'class', 'tag', or 'text'."),
      selector_value: z.string().describe("The value to search for based on the selector type."),
      text: z.string().describe("The text to input into the element."),
      window_label: z.string().default("main").describe("The identifier of the application window to search in. Defaults to 'main' if not specified."),
      delay_ms: z.number().default(20).describe("The delay between keystrokes in milliseconds (for realistic typing simulation). Default is 20ms."),
    },
    {
      title: "Send Text to Element",
      readOnlyHint: false, // This modifies state
      destructiveHint: true, // This is a modification
      idempotentHint: false, // Text input can have side effects
      openWorldHint: false,
    },
    async ({ selector_type, selector_value, text, window_label, delay_ms }) => {
      try {
        console.error(`Sending text to element with params: ${JSON.stringify({
          selector_type,
          selector_value,
          text,
          window_label,
          delay_ms
        })}`);
        
        // Create the payload object
        const payload = {
          selector_type,
          selector_value,
          text,
          window_label,
          delay_ms
        };
        
        const result = await socketClient.sendCommand('send_text_to_element', payload);
        
        console.error(`Got result: ${JSON.stringify(result)}`);
        
        // Process the result
        if (!result || typeof result !== 'object') {
          const errorMsg = 'Failed to get a valid response';
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: errorMsg,
              },
            ],
          };
        }
        
        // The server can provide two different response formats:
        // 1. Direct object with data property containing element info
        // 2. Response with success flag and nested data property
        
        // If the result has a data property at the top level with element info
        if (result.element) {
          const elementInfo = result.element;
          return {
            content: [
              {
                type: "text",
                text: `Successfully sent text to ${elementInfo.tag || ''} element${elementInfo.id ? ` with id "${elementInfo.id}"` : ''}.\nText: "${text}"`,
              },
            ],
            isError: false,
          };
        }
        
        // Check if it's a standard response object
        if ('success' in result) {
          if (result.success === true) {
            // Handle data embedded in the data property
            const data = result.data || {};
            const elementInfo = data.element || {};
            
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully sent text to ${elementInfo.tag || ''} element${elementInfo.id ? ` with id "${elementInfo.id}"` : ''}.\nText: "${text}"`,
                },
              ],
              isError: false,
            };
          } else {
            // Handle error from the success:false case
            const errorMsg = result.error || 'Failed to send text to element';
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: errorMsg,
                },
              ],
            };
          }
        }
        
        // Try one more case - direct object with the element details
        if (result.data && result.data.element) {
          const elementInfo = result.data.element;
          return {
            content: [
              {
                type: "text",
                text: `Successfully sent text to ${elementInfo.tag || ''} element${elementInfo.id ? ` with id "${elementInfo.id}"` : ''}.\nText: "${text}"`,
              },
            ],
            isError: false,
          };
        }
        
        // If we get here, the response format wasn't recognized
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Response format unexpected: ${JSON.stringify(result)}`,
            },
          ],
        };
      } catch (error) {
        console.error('Error sending text to element:', error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to send text to element: ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
} 