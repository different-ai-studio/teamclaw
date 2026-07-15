import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";

export function registerManageWindowTool(server: McpServer) {
  server.tool(
    "manage_window",
    "Manages the state and geometry of Tauri application windows. Allows operations such as focusing, minimizing, maximizing, closing, showing/hiding, positioning, resizing, centering, and toggling fullscreen. Some operations like 'close' are destructive.",
    {
      operation: z.enum(["focus", "minimize", "maximize", "unmaximize", "close", "show", "hide", "setPosition", "setSize", "center", "toggleFullscreen"]).describe("Required. The window management operation to perform. Valid values are: focus, minimize, maximize, unmaximize, close, show, hide, setPosition, setSize, center, toggleFullscreen."),
      window_label: z.string().default("main").describe("The identifier (e.g., visible title or internal label) of the application window to control. Defaults to 'main' if not specified."),
      x: z.number().int().optional().describe("The X-coordinate (in screen pixels) for the window's top-left corner. Required and used only for the 'setPosition' operation."),
      y: z.number().int().optional().describe("The Y-coordinate (in screen pixels) for the window's top-left corner. Required and used only for the 'setPosition' operation."),
      width: z.number().int().positive().optional().describe("The desired width of the window in pixels. Required and used only for the 'setSize' operation."),
      height: z.number().int().positive().optional().describe("The desired height of the window in pixels. Required and used only for the 'setSize' operation."),
    },
    {
      title: "Control Application Window State and Geometry",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ operation, window_label, x, y, width, height }) => {
      try {
        console.error(`Managing window with params: ${JSON.stringify({
          operation,
          window_label,
          x,
          y,
          width,
          height
        })}`);
        
        await socketClient.sendCommand('manage_window', {
          operation,
          window_label,
          x,
          y,
          width,
          height
        });
        
        return {
          content: [
            {
              type: "text",
              text: `Window operation '${operation}' completed successfully`,
            },
          ],
        };
      } catch (error) {
        console.error('Window management error:', error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to manage window: ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
} 