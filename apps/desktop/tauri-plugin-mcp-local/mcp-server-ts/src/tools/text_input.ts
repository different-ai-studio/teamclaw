import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";

export function registerTextInputTool(server: McpServer) {
  server.tool(
    "simulate_text_input",
    "Simulates keyboard input, typing the specified text content character by character into the currently focused input field or application element. Allows configuration of typing speed via inter-keystroke delay and initial delay. This action modifies the content of the target input field.",
    {
      text: z.string().describe("Required. The string of text content to be typed out by the simulated keyboard input."),
      delay_ms: z.number().int().nonnegative().optional().describe("The delay in milliseconds between each simulated keystroke. Adjusts the typing speed."),
      initial_delay_ms: z.number().int().nonnegative().optional().describe("An initial delay in milliseconds before the simulation of typing begins. Useful for ensuring the target field is ready."),
    },
    {
      title: "Simulate Keyboard Text Input into Focused Field",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ text, delay_ms, initial_delay_ms }) => {
      try {
        // Validate required parameters
        if (!text) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "The text parameter is required and cannot be empty",
              },
            ],
          };
        }
        
        console.error(`Simulating text input with params: ${JSON.stringify({
          text: text.length > 50 ? `${text.substring(0, 50)}...` : text,
          delay_ms,
          initial_delay_ms
        })}`);
        
        await socketClient.sendCommand('simulate_text_input', {
          text,
          delay_ms,
          initial_delay_ms
        });
        
        return {
          content: [
            {
              type: "text",
              text: `Successfully simulated typing of ${text.length} characters`,
            },
          ],
        };
      } catch (error) {
        console.error('Text input simulation error:', error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to simulate text input: ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
} 