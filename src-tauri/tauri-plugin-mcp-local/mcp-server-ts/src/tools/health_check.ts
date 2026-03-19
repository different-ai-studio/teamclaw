import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse } from "./response-helpers.js";

export function registerHealthCheckTool(server: McpServer) {
  server.tool(
    "health_check",
    "Queries the health status of the Tauri MCP plugin. Returns plugin version, build information, system details, available capabilities, and connection status. Use this before attempting other operations to ensure the plugin is functioning properly.",
    {},
    {
      title: "Check Plugin Health Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        const params = {};
        console.error("Health check requested");

        const result = await socketClient.sendCommand("health_check", params);

        // Validate the response structure
        if (
          !result ||
          typeof result !== "object" ||
          !("status" in result)
        ) {
          console.error(
            "Invalid health check response:",
            JSON.stringify(result)
          );
          return createErrorResponse(
            `Invalid health check response: ${JSON.stringify(result).substring(0, 100)}...`
          );
        }

        // Format the response for MCP clients
        const healthInfo = result as {
          status: string;
          pluginVersion: string;
          buildInfo: {
            version: string;
            rustVersion: string;
            profile: string;
          };
          systemInfo: {
            os: string;
            platform: string;
            arch: string;
            cpuCount: number;
          };
          capabilities: string[];
          connectionStatus: {
            socketServerRunning: boolean;
            eventSystemAvailable: boolean;
          };
          webviewStatus: {
            webviewAvailable: boolean;
            mainWindowAvailable: boolean;
          };
        };

        // Build a detailed text report
        const report = [
          `Plugin Status: ${healthInfo.status}`,
          `Plugin Version: ${healthInfo.pluginVersion}`,
          ``,
          `Build Information:`,
          `  - Version: ${healthInfo.buildInfo.version}`,
          `  - Rust Version: ${healthInfo.buildInfo.rustVersion}`,
          `  - Profile: ${healthInfo.buildInfo.profile}`,
          ``,
          `System Information:`,
          `  - OS: ${healthInfo.systemInfo.os}`,
          `  - Platform: ${healthInfo.systemInfo.platform}`,
          `  - Architecture: ${healthInfo.systemInfo.arch}`,
          `  - CPU Count: ${healthInfo.systemInfo.cpuCount}`,
          ``,
          `Connection Status:`,
          `  - Socket Server Running: ${healthInfo.connectionStatus.socketServerRunning ? "Yes" : "No"}`,
          `  - Event System Available: ${healthInfo.connectionStatus.eventSystemAvailable ? "Yes" : "No"}`,
          ``,
          `Webview Status:`,
          `  - Webview Available: ${healthInfo.webviewStatus.webviewAvailable ? "Yes" : "No"}`,
          `  - Main Window Available: ${healthInfo.webviewStatus.mainWindowAvailable ? "Yes" : "No"}`,
          ``,
          `Available Capabilities (${healthInfo.capabilities.length} tools):`,
          ...healthInfo.capabilities.map((cap) => `  - ${cap}`),
        ].join("\n");

        return createSuccessResponse(report);
      } catch (error) {
        console.error("Health check error:", error);
        return createErrorResponse(
          `Health check failed: ${(error as Error).message}`
        );
      }
    }
  );
}
