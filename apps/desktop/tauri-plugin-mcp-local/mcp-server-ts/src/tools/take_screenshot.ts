import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createImageResponse, extractBase64Data, logCommandParams } from "./response-helpers.js";

export function registerTakeScreenshotTool(server: McpServer) {
  server.tool(
    "take_screenshot",
    "Captures a still image (screenshot) of a designated application window and returns it, typically as a JPEG image. This tool is read-only and does not modify any application or system state. Useful for visual inspection or documentation.",
    {
      window_label: z.string().default("main").describe("The identifier for the window to capture. This could be the window's visible title text or a unique internal label if available. Ensure this label accurately targets the desired window. Defaults to 'main' if not specified."),
    },
    {
      title: "Capture Screenshot of a Specific Application Window",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label }) => {
      try {
        // The window_label now has a default value in the schema, so this check is redundant
        // But we'll keep it for extra safety
        if (!window_label) {
          window_label = "main";
        }
        
        const params = { window_label };
        logCommandParams('take_screenshot', params);
        
        const result = await socketClient.sendCommand('take_screenshot', params);
        
        console.error(`Got screenshot result type: ${typeof result}`);
        
        // Use our shared utility to extract base64 data
        const base64Data = extractBase64Data(result);
        
        if (!base64Data) {
          console.error('Failed to extract base64 data from response:', JSON.stringify(result));
          return createErrorResponse(`Failed to extract image data from response: ${JSON.stringify(result).substring(0, 100)}...`);
        }
        
        return createImageResponse(base64Data, 'image/jpeg');
      } catch (error) {
        console.error('Screenshot error:', error);
        return createErrorResponse(`Failed to take screenshot: ${(error as Error).message}`);
      }
    },
  );
} 