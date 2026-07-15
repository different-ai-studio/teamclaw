import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

export function registerPerformanceMetricsTool(server: McpServer) {
  server.tool(
    "get_performance_metrics",
    "Retrieves application performance metrics including navigation timing, resource timing, user timing marks/measures, memory usage, and long tasks. Helps understand application performance and identify bottlenecks. Useful for AI agents to evaluate application responsiveness and resource efficiency.",
    {
      include_navigation: z.boolean().optional().describe("Optional. Include navigation timing data (page load metrics). Defaults to true."),
      include_resources: z.boolean().optional().describe("Optional. Include resource timing data (script, stylesheet, image load times). Defaults to true."),
      include_user_timing: z.boolean().optional().describe("Optional. Include user-defined timing marks and measures. Defaults to true."),
      include_memory: z.boolean().optional().describe("Optional. Include memory usage data (if available). Defaults to true."),
      include_long_tasks: z.boolean().optional().describe("Optional. Include long tasks (main thread blocks > 50ms). Defaults to false."),
      resource_types: z.array(z.string()).optional().describe("Optional. Filter resources by type (e.g., 'script', 'stylesheet', 'image', 'fetch', 'xmlhttprequest'). If not specified, all resource types are included."),
      min_duration_ms: z.number().optional().describe("Optional. Only include resources with duration >= this value in milliseconds."),
      max_duration_ms: z.number().optional().describe("Optional. Only include resources with duration <= this value in milliseconds."),
      window_label: z.string().optional().describe("Optional. The identifier of the application window to inspect. Defaults to 'main' if not specified."),
    },
    {
      title: "Get Application Performance Metrics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({
      include_navigation,
      include_resources,
      include_user_timing,
      include_memory,
      include_long_tasks,
      resource_types,
      min_duration_ms,
      max_duration_ms,
      window_label,
    }) => {
      try {
        const params = {
          window_label: window_label || "main",
          include_navigation: include_navigation !== false,
          include_resources: include_resources !== false,
          include_user_timing: include_user_timing !== false,
          include_memory: include_memory !== false,
          include_long_tasks: include_long_tasks || false,
          resource_filter: {
            resource_type: resource_types && resource_types.length > 0 ? resource_types : undefined,
            min_duration_ms: min_duration_ms,
            max_duration_ms: max_duration_ms,
          },
        };

        logCommandParams("get_performance_metrics", params);

        const result = await socketClient.sendCommand("get_performance_metrics", params);

        console.error(`Got performance metrics result: ${typeof result}`);

        // Format the result for display
        if (typeof result === "object" && result && "metrics" in result) {
          const metricsData = result as {
            metrics: Record<string, any>;
            collected_at_ms: number;
            errors: string[];
          };

          // Build a formatted output showing key metrics
          let output = "Performance Metrics Report\n";
          output += "=".repeat(60) + "\n";
          output += `Collected at: ${new Date(metricsData.collected_at_ms).toISOString()}\n\n`;

          // Navigation Timing Summary
          if (metricsData.metrics.navigation_timing) {
            const nav = metricsData.metrics.navigation_timing;
            output += "Navigation Timing\n";
            output += "-".repeat(40) + "\n";
            output += `  Total Page Load: ${nav.total_page_load_ms?.toFixed(0)}ms\n`;
            output += `  Time to Interactive: ${nav.time_to_interactive_ms?.toFixed(0)}ms\n`;
            output += `  DOM Complete: ${nav.dom_complete_ms?.toFixed(0)}ms\n`;
            output += `  DNS Lookup: ${nav.dns_lookup_ms?.toFixed(0)}ms\n`;
            output += `  TCP Connection: ${nav.tcp_connection_ms?.toFixed(0)}ms\n`;
            output += `  Request Time: ${nav.request_time_ms?.toFixed(0)}ms\n`;
            output += `  Response Time: ${nav.response_time_ms?.toFixed(0)}ms\n`;
            if (nav.first_paint_ms !== null && nav.first_paint_ms !== undefined) {
              output += `  First Paint: ${nav.first_paint_ms.toFixed(0)}ms\n`;
            }
            output += "\n";
          }

          // Resource Timing Summary
          if (metricsData.metrics.resource_timing) {
            const resources = metricsData.metrics.resource_timing;
            output += "Resource Timing Summary\n";
            output += "-".repeat(40) + "\n";
            output += `  Total Resources: ${resources.summary?.total_resources || 0}\n`;
            output += `  Total Duration: ${resources.summary?.total_duration_ms?.toFixed(0)}ms\n`;
            output += `  Cached Resources: ${resources.summary?.cached_resources || 0}\n`;
            output += `  Network Resources: ${resources.summary?.network_resources || 0}\n`;
            output += `  Largest Transfer Size: ${resources.summary?.largest_transfer_size_bytes || 0} bytes\n`;

            // Show resources by type
            if (resources.by_type) {
              output += "\n  Resources by Type:\n";
              for (const [type, typeResources] of Object.entries(resources.by_type)) {
                const typeArray = typeResources as Array<{ duration_ms: number; transfer_size: number }>;
                const count = typeArray.length;
                const totalDuration = typeArray.reduce((sum, r) => sum + r.duration_ms, 0);
                const totalSize = typeArray.reduce((sum, r) => sum + r.transfer_size, 0);
                output += `    ${type}: ${count} resources, ${totalDuration.toFixed(0)}ms, ${totalSize} bytes\n`;
              }
            }
            output += "\n";
          }

          // User Timing
          if (metricsData.metrics.user_timing) {
            const userTiming = metricsData.metrics.user_timing;
            output += "User Timing\n";
            output += "-".repeat(40) + "\n";
            if (userTiming.marks && userTiming.marks.length > 0) {
              output += `  Marks: ${userTiming.marks.length}\n`;
              userTiming.marks.slice(0, 5).forEach((mark: any) => {
                output += `    - ${mark.name} @ ${mark.start_time_ms.toFixed(0)}ms\n`;
              });
              if (userTiming.marks.length > 5) {
                output += `    ... and ${userTiming.marks.length - 5} more\n`;
              }
            }
            if (userTiming.measures && userTiming.measures.length > 0) {
              output += `  Measures: ${userTiming.measures.length}\n`;
              userTiming.measures.slice(0, 5).forEach((measure: any) => {
                output += `    - ${measure.name}: ${measure.duration_ms.toFixed(0)}ms\n`;
              });
              if (userTiming.measures.length > 5) {
                output += `    ... and ${userTiming.measures.length - 5} more\n`;
              }
            }
            output += "\n";
          }

          // Memory Usage
          if (metricsData.metrics.memory_usage) {
            const memory = metricsData.metrics.memory_usage;
            if (memory.available === false) {
              output += "Memory Usage\n";
              output += "-".repeat(40) + "\n";
              output += `  ${memory.reason}\n\n`;
            } else {
              output += "Memory Usage\n";
              output += "-".repeat(40) + "\n";
              output += `  Used JS Heap: ${(memory.used_js_heap_size_bytes / 1024 / 1024).toFixed(2)}MB\n`;
              output += `  Total JS Heap: ${(memory.total_js_heap_size_bytes / 1024 / 1024).toFixed(2)}MB\n`;
              output += `  Heap Size Limit: ${(memory.js_heap_size_limit_bytes / 1024 / 1024).toFixed(2)}MB\n`;
              output += `  Heap Usage: ${memory.heap_usage_percent}%\n`;
              output += `  Available: ${(memory.available_bytes / 1024 / 1024).toFixed(2)}MB\n\n`;
            }
          }

          // Paint Timing
          if (metricsData.metrics.paint_timing && metricsData.metrics.paint_timing.length > 0) {
            output += "Paint Timing\n";
            output += "-".repeat(40) + "\n";
            metricsData.metrics.paint_timing.forEach((paint: any) => {
              output += `  ${paint.name}: ${paint.start_time_ms.toFixed(0)}ms\n`;
            });
            output += "\n";
          }

          // Largest Contentful Paint
          if (metricsData.metrics.largest_contentful_paint) {
            const lcp = metricsData.metrics.largest_contentful_paint;
            output += "Largest Contentful Paint\n";
            output += "-".repeat(40) + "\n";
            output += `  Start Time: ${lcp.start_time_ms?.toFixed(0)}ms\n`;
            output += `  Render Time: ${lcp.render_time_ms?.toFixed(0)}ms\n`;
            output += `  Size: ${lcp.size || 0} bytes\n`;
            if (lcp.element) {
              output += `  Element: <${lcp.element}>\n`;
            }
            output += "\n";
          }

          // Long Tasks
          if (metricsData.metrics.long_tasks) {
            const longTasks = metricsData.metrics.long_tasks;
            output += "Long Tasks (> 50ms)\n";
            output += "-".repeat(40) + "\n";
            output += `  Total Long Tasks: ${longTasks.count}\n`;
            if (longTasks.tasks && longTasks.tasks.length > 0) {
              longTasks.tasks.slice(0, 5).forEach((task: any) => {
                output += `    - ${task.duration_ms.toFixed(0)}ms @ ${task.start_time_ms.toFixed(0)}ms\n`;
              });
              if (longTasks.tasks.length > 5) {
                output += `    ... and ${longTasks.tasks.length - 5} more\n`;
              }
            }
            output += "\n";
          }

          // Errors
          if (metricsData.errors && metricsData.errors.length > 0) {
            output += "Warnings/Errors\n";
            output += "-".repeat(40) + "\n";
            metricsData.errors.slice(0, 5).forEach((error: string) => {
              output += `  - ${error}\n`;
            });
            if (metricsData.errors.length > 5) {
              output += `  ... and ${metricsData.errors.length - 5} more\n`;
            }
            output += "\n";
          }

          output += "=".repeat(60) + "\n";
          output += "Raw Metrics Data:\n";
          output += JSON.stringify(metricsData, null, 2);

          return createSuccessResponse(output);
        }

        return createSuccessResponse(formatResultAsText(result));
      } catch (error) {
        console.error("Performance metrics error:", error);
        return createErrorResponse(`Failed to retrieve performance metrics: ${(error as Error).message}`);
      }
    }
  );
}
