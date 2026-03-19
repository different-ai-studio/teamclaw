import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

// Helper function to format element info text
function formatElementInfo(element: any, position: { x: number, y: number }, clickInfo: string): string {
  return `Found ${element.tag || ''} element${element.id ? ` with id "${element.id}"` : ''}${element.classes ? ` and classes "${element.classes}"` : ''}.
Position (raw coordinates for mouse movement): x=${position.x}, y=${position.y}
${clickInfo}`;
}

export function registerGetElementPositionTool(server: McpServer) {
  server.tool(
    "get_element_position",
    "Finds an HTML element on the page by ID, class, tag name, or text content, and returns its raw position coordinates for use with mouse_movement. Can optionally click the element.",
    {
      selector_type: z.enum(["id", "class", "tag", "text"]).describe("The type of selector to use: 'id', 'class', 'tag', or 'text'."),
      selector_value: z.string().describe("The value to search for based on the selector type."),
      window_label: z.string().default("main").describe("The identifier of the application window to search in. Defaults to 'main' if not specified."),
      should_click: z.boolean().default(false).describe("Whether to click the element once found. Default is false."),
    },
    {
      title: "Find Element and Get Position",
      readOnlyHint: false, // Might be false since it could click
      destructiveHint: true, // Potentially destructive since it might click
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ selector_type, selector_value, window_label, should_click }) => {
      try {
        const payload = {
          selector_type,
          selector_value,
          window_label,
          should_click
        };
        
        logCommandParams('get_element_position', payload);
        
        const result = await socketClient.sendCommand('get_element_position', payload);
        
        console.error(`Got result: ${JSON.stringify(result)}`);
        
        // Handle invalid response
        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }
        
        // Process response based on format
        
        // Case 1: Direct top-level format
        if (result.element && 'x' in result && 'y' in result) {
          const clickInfo = result.clicked ? 
            (result.clickResult?.success ? "Element was clicked successfully." : "Click attempt failed.") : "";
          
          return createSuccessResponse(formatElementInfo(
            result.element, 
            { x: result.x, y: result.y }, 
            clickInfo
          ));
        }
        
        // Case 2: Nested data format
        if (result.data) {
          const data = result.data;
          if (data.element && 'x' in data && 'y' in data) {
            const clickInfo = data.clicked ? 
              (data.clickResult?.success ? "Element was clicked successfully." : "Click attempt failed.") : "";
            
            return createSuccessResponse(formatElementInfo(
              data.element,
              { x: data.x, y: data.y },
              clickInfo
            ));
          }
        }
        
        // Case 3: Success property format
        if ('success' in result) {
          if (result.success === true && result.data) {
            const data = result.data;
            const element = data.element || {};
            const clickInfo = data.clicked ? 
              (data.clickResult?.success ? "Element was clicked successfully." : "Click attempt failed.") : "";
            
            return createSuccessResponse(formatElementInfo(
              element,
              { x: data.x, y: data.y },
              clickInfo
            ));
          } else if (!result.success) {
            return createErrorResponse(result.error || 'Failed to find element');
          }
        }
        
        // Fallback error case
        return createErrorResponse(`Element found, but response format unexpected. Response data: ${JSON.stringify(result)}`);
      } catch (error) {
        console.error('Element finding error:', error);
        return createErrorResponse(`Failed to find element: ${(error as Error).message}`);
      }
    },
  );
} 