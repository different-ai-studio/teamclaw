import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";

export function registerMouseMovementTool(server: McpServer) {
  server.tool(
    "simulate_mouse_movement",
    "Simulates the movement of the mouse cursor to specified screen coordinates, either absolute or relative to its current position. This action can trigger hover events or other UI interactions in the targeted application or operating system. Considered destructive as it can alter UI state or initiate actions.",
    {
      x: z.number().int().describe("Required. The target X-coordinate for the mouse cursor, in screen pixels."),
      y: z.number().int().describe("Required. The target Y-coordinate for the mouse cursor, in screen pixels."),
      relative: z.boolean().optional().describe("If true, the x and y coordinates are treated as offsets relative to the mouse cursor's current position. If false (default), x and y are absolute screen coordinates."),
      click: z.boolean().optional().describe("If true, performs a mouse click at the target coordinates after movement. Default is false."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Specifies which mouse button to click. Options are 'left', 'right', or 'middle'. Default is 'left'."),
    },
    {
      title: "Simulate Mouse Cursor Movement",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ x, y, relative, click, button }) => {
      try {
        // X and Y are required by the Zod schema, but let's validate they're numbers
        if (typeof x !== 'number' || typeof y !== 'number') {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Both x and y coordinates must be valid numbers",
              },
            ],
          };
        }
        
        console.error(`Simulating mouse movement with params: ${JSON.stringify({
          x,
          y,
          relative,
          click,
          button
        })}`);
        
        await socketClient.sendCommand('simulate_mouse_movement', {
          x,
          y,
          relative,
          click,
          button
        });
        
        const actionText = click 
          ? `Successfully moved mouse to coordinates (${x}, ${y})${relative ? ' (relative)' : ''} and clicked ${button || 'left'} button`
          : `Successfully moved mouse to coordinates (${x}, ${y})${relative ? ' (relative)' : ''}`;

        return {
          content: [
            {
              type: "text",
              text: actionText,
            },
          ],
        };
      } catch (error) {
        console.error('Mouse movement simulation error:', error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to simulate mouse movement: ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
} 