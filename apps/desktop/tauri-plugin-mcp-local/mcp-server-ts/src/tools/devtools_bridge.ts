import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

export function registerDevToolsBridgeTool(server: McpServer) {
  server.tool(
    "query_devtools_hierarchy",
    "Queries the React/Vue DevTools protocol to retrieve deep component hierarchy, props, state, and hooks data. Detects framework type and version, retrieves component tree with full introspection data including props, state from hooks (useState, useReducer, etc.), and computed properties. Handles large component trees gracefully with pagination and filtering.",
    {
      window_label: z.string().default("main").describe("The identifier (e.g., visible title or internal label) of the application window from which to retrieve DevTools data. Defaults to 'main' if not specified."),
      max_depth: z.number().int().positive().default(10).describe("Maximum depth for recursive component tree traversal. Prevents infinite recursion and truncates very deep nested structures. Defaults to 10."),
      component_filter: z.string().optional().describe("Optional filter pattern to match component names (case-sensitive substring match). If provided, only components whose names include this pattern are returned in the tree."),
      timeout_ms: z.number().int().positive().optional().describe("Maximum time in milliseconds to wait for the DevTools query operation to complete. Defaults to 5000ms if not specified."),
    },
    {
      title: "Query React/Vue DevTools Component Hierarchy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, max_depth, component_filter, timeout_ms }) => {
      try {
        const params = { window_label, max_depth, component_filter, timeout_ms };
        logCommandParams('query_devtools_hierarchy', params);

        const effectiveWindowLabel = window_label || 'main';

        const result = await socketClient.sendCommand('devtools_bridge', {
          window_label: effectiveWindowLabel,
          max_depth: max_depth || 10,
          component_filter,
          timeout_ms: timeout_ms || 5000
        });

        console.error(`Got DevTools bridge result type: ${typeof result}`);

        // Format the result for output
        let formattedOutput = '';

        if (result && typeof result === 'object') {
          const { framework, components, metadata } = result as any;

          // Build the output text
          formattedOutput += `# DevTools Component Hierarchy\n\n`;

          // Framework info section
          if (framework) {
            formattedOutput += `## Framework Information\n`;
            formattedOutput += `- Framework: ${framework.framework_type || 'unknown'}\n`;
            if (framework.react_version) {
              formattedOutput += `- React Version: ${framework.react_version}\n`;
            }
            if (framework.vue_version) {
              formattedOutput += `- Vue Version: ${framework.vue_version}\n`;
            }
            formattedOutput += `\n`;
          }

          // Component statistics
          if (metadata) {
            formattedOutput += `## Statistics\n`;
            formattedOutput += `- Total Components Found: ${metadata.total_components || 0}\n`;
            formattedOutput += `- Truncated: ${metadata.truncated || false}\n`;
            formattedOutput += `- Max Depth Reached: ${metadata.max_depth_reached || false}\n`;

            if (metadata.errors && metadata.errors.length > 0) {
              formattedOutput += `- Extraction Errors:\n`;
              metadata.errors.forEach((error: string) => {
                formattedOutput += `  - ${error}\n`;
              });
            }
            formattedOutput += `\n`;
          }

          // Component details
          if (components && components.length > 0) {
            formattedOutput += `## Component Tree\n\n`;

            const formatComponentTree = (comps: any[], indent = 0) => {
              return comps.map(comp => {
                const prefix = '  '.repeat(indent) + '- ';
                let output = `${prefix}**${comp.name || 'Anonymous'}** (ID: ${comp.id})\n`;

                if (comp.props) {
                  output += `${prefix}  Props:\n`;
                  output += `${prefix}  \`\`\`json\n`;
                  output += JSON.stringify(comp.props, null, 2).split('\n').map((line: string) => `${prefix}  ${line}`).join('\n') + '\n';
                  output += `${prefix}  \`\`\`\n`;
                }

                if (comp.state) {
                  output += `${prefix}  State:\n`;
                  output += `${prefix}  \`\`\`json\n`;
                  output += JSON.stringify(comp.state, null, 2).split('\n').map((line: string) => `${prefix}  ${line}`).join('\n') + '\n';
                  output += `${prefix}  \`\`\`\n`;
                }

                if (comp.hooks && comp.hooks.length > 0) {
                  output += `${prefix}  Hooks:\n`;
                  comp.hooks.forEach((hook: any) => {
                    output += `${prefix}    - ${hook.hook_name}: `;
                    output += JSON.stringify(hook.hook_value).substring(0, 100);
                    if (JSON.stringify(hook.hook_value).length > 100) {
                      output += '...';
                    }
                    output += '\n';
                  });
                }

                if (comp.computed) {
                  output += `${prefix}  Computed:\n`;
                  output += `${prefix}  \`\`\`json\n`;
                  output += JSON.stringify(comp.computed, null, 2).split('\n').map((line: string) => `${prefix}  ${line}`).join('\n') + '\n';
                  output += `${prefix}  \`\`\`\n`;
                }

                if (comp.children && comp.children.length > 0) {
                  output += formatComponentTree(comp.children, indent + 1);
                }

                return output;
              }).join('');
            };

            formattedOutput += formatComponentTree(components);
          } else {
            formattedOutput += `## Components\n\n`;
            formattedOutput += `No components found matching the criteria.\n`;
          }

          return createSuccessResponse(formattedOutput);
        } else {
          return createSuccessResponse(formatResultAsText(result));
        }
      } catch (error) {
        console.error('DevTools bridge error:', error);
        return createErrorResponse(`Failed to query DevTools hierarchy: ${(error as Error).message}`);
      }
    },
  );

  // Register a companion tool for getting component props/state in detail
  server.tool(
    "devtools_inspect_component",
    "Detailed inspection of a specific component from the DevTools hierarchy. Returns comprehensive information about a component's props, state, hooks, and computed properties. Useful for deep debugging of specific component instances.",
    {
      window_label: z.string().default("main").describe("The identifier of the application window. Defaults to 'main' if not specified."),
      component_name: z.string().describe("The name of the component to inspect in detail. Supports substring matching."),
      max_depth: z.number().int().positive().default(15).describe("Maximum depth for recursive property traversal. Defaults to 15."),
      timeout_ms: z.number().int().positive().optional().describe("Maximum time in milliseconds to wait for the inspection. Defaults to 5000ms."),
    },
    {
      title: "Inspect Specific Component in Detail",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, component_name, max_depth, timeout_ms }) => {
      try {
        const params = { window_label, component_name, max_depth, timeout_ms };
        logCommandParams('devtools_inspect_component', params);

        const effectiveWindowLabel = window_label || 'main';

        // First, get the full tree filtered to the component
        const result = await socketClient.sendCommand('devtools_bridge', {
          window_label: effectiveWindowLabel,
          max_depth: max_depth || 15,
          component_filter: component_name,
          timeout_ms: timeout_ms || 5000
        });

        console.error(`Got DevTools inspection result type: ${typeof result}`);

        let formattedOutput = '';

        if (result && typeof result === 'object') {
          const { framework, components } = result as any;

          if (!components || components.length === 0) {
            return createErrorResponse(`No components found matching name: ${component_name}`);
          }

          // Get the first matching component
          const component = components[0];

          formattedOutput += `# Component Inspection: ${component.name}\n\n`;
          formattedOutput += `## Component ID\n\`${component.id}\`\n\n`;

          formattedOutput += `## Framework\n${framework?.framework_type || 'unknown'}\n\n`;

          if (component.props) {
            formattedOutput += `## Props\n\`\`\`json\n`;
            formattedOutput += JSON.stringify(component.props, null, 2);
            formattedOutput += `\n\`\`\`\n\n`;
          }

          if (component.state) {
            formattedOutput += `## State\n\`\`\`json\n`;
            formattedOutput += JSON.stringify(component.state, null, 2);
            formattedOutput += `\n\`\`\`\n\n`;
          }

          if (component.hooks && component.hooks.length > 0) {
            formattedOutput += `## Hooks\n\n`;
            component.hooks.forEach((hook: any) => {
              formattedOutput += `### ${hook.hook_name}\n\`\`\`json\n`;
              formattedOutput += JSON.stringify(hook.hook_value, null, 2);
              formattedOutput += `\n\`\`\`\n\n`;
            });
          }

          if (component.computed) {
            formattedOutput += `## Computed Properties\n\`\`\`json\n`;
            formattedOutput += JSON.stringify(component.computed, null, 2);
            formattedOutput += `\n\`\`\`\n\n`;
          }

          return createSuccessResponse(formattedOutput);
        } else {
          return createErrorResponse('Invalid response format from DevTools bridge');
        }
      } catch (error) {
        console.error('DevTools inspection error:', error);
        return createErrorResponse(`Failed to inspect component: ${(error as Error).message}`);
      }
    },
  );

  // Register a tool for checking framework detection
  server.tool(
    "check_devtools_availability",
    "Checks which DevTools are available in the current window and returns framework information. Useful for verifying if React DevTools, Vue DevTools, or other framework inspection tools are accessible.",
    {
      window_label: z.string().default("main").describe("The identifier of the application window. Defaults to 'main' if not specified."),
      timeout_ms: z.number().int().positive().optional().describe("Maximum time in milliseconds to wait. Defaults to 3000ms."),
    },
    {
      title: "Check Available DevTools",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, timeout_ms }) => {
      try {
        const params = { window_label, timeout_ms };
        logCommandParams('check_devtools_availability', params);

        const effectiveWindowLabel = window_label || 'main';

        // Get the framework info by querying with max_depth=0
        const result = await socketClient.sendCommand('devtools_bridge', {
          window_label: effectiveWindowLabel,
          max_depth: 0,
          timeout_ms: timeout_ms || 3000
        });

        console.error(`Got DevTools availability check result type: ${typeof result}`);

        let formattedOutput = '';

        if (result && typeof result === 'object') {
          const { framework, metadata } = result as any;

          formattedOutput += `# DevTools Availability Check\n\n`;

          if (framework) {
            formattedOutput += `## Detected Framework\n`;
            formattedOutput += `- Type: ${framework.framework_type}\n`;

            if (framework.react_version) {
              formattedOutput += `- React Version: ${framework.react_version}\n`;
              formattedOutput += `- Status: ✓ React DevTools available\n`;
            }

            if (framework.vue_version) {
              formattedOutput += `- Vue Version: ${framework.vue_version}\n`;
              formattedOutput += `- Status: ✓ Vue DevTools available\n`;
            }

            if (framework.framework_type === 'none') {
              formattedOutput += `- Status: No framework DevTools detected\n`;
            }

            formattedOutput += `\n`;
          }

          if (metadata?.errors && metadata.errors.length > 0) {
            formattedOutput += `## Errors Encountered\n`;
            metadata.errors.forEach((error: string) => {
              formattedOutput += `- ${error}\n`;
            });
            formattedOutput += `\n`;
          }

          formattedOutput += `## Recommendations\n`;
          if (framework?.framework_type === 'none') {
            formattedOutput += `- No React or Vue DevTools detected. Ensure React/Vue DevTools browser extension is installed or framework is loaded in development mode.\n`;
          } else if (framework?.framework_type === 'react') {
            formattedOutput += `- React DevTools detected. Use the query_devtools_hierarchy tool to explore components.\n`;
          } else if (framework?.framework_type === 'vue') {
            formattedOutput += `- Vue DevTools detected. Use the query_devtools_hierarchy tool to explore components.\n`;
          } else if (framework?.framework_type === 'both') {
            formattedOutput += `- Both React and Vue detected. Use the query_devtools_hierarchy tool to explore components from either framework.\n`;
          }

          return createSuccessResponse(formattedOutput);
        } else {
          return createErrorResponse('Invalid response format from DevTools bridge');
        }
      } catch (error) {
        console.error('DevTools availability check error:', error);
        return createErrorResponse(`Failed to check DevTools availability: ${(error as Error).message}`);
      }
    },
  );
}
