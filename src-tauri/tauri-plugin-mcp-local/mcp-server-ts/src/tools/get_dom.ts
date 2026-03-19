import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";

export function registerGetDomTool(server: McpServer) {
  server.tool(
    "get_dom",
    "Retrieves the full HTML Document Object Model (DOM) content from the specified application window as a string. This tool is read-only and provides a snapshot of the window's current HTML structure. Useful for parsing, analysis, or data extraction.",
    {
      window_label: z.string().default("main").describe("The identifier (e.g., visible title or internal label) of the application window from which to retrieve the DOM content. Defaults to 'main' if not specified."),
    },
    {
      title: "Retrieve HTML DOM Content from Application Window",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label }) => {
      try {
        console.error(`Getting DOM with params: ${JSON.stringify({
          window_label
        })}`);
        
        // The server expects just a string, not an object
        const result = await socketClient.sendCommand('get_dom', window_label);
        
        console.error(`Got DOM result type: ${typeof result}, length: ${
          typeof result === 'string' ? result.length : 'unknown'
        }`);
        
        // Ensure we have a string result
        let domContent;
        if (typeof result === 'string') {
          domContent = result;
        } else if (result && typeof result === 'object') {
          if (typeof result.data === 'string') {
            domContent = result.data;
          } else {
            domContent = JSON.stringify(result);
          }
        } else {
          domContent = String(result);
        }
        
        return {
          content: [
            {
              type: "text",
              text: domContent,
            },
          ],
        };
      } catch (error) {
        console.error('DOM retrieval error:', error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to get DOM: ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
} 