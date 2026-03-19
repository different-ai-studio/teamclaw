import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

// Define storage types
const STORAGE_TYPES = ["localStorage", "sessionStorage", "indexedDB"] as const;

// Define actions
const ACTIONS = ["get_storage", "clear_storage", "list_indexeddb", "query_indexeddb"] as const;

export function registerStorageInspectorTool(server: McpServer) {
  server.tool(
    "storage_inspector",
    "Inspects and retrieves browser storage data including localStorage, sessionStorage, and IndexedDB. Supports querying, filtering, pagination, and introspection of IndexedDB databases and object stores.",
    {
      action: z.enum(ACTIONS).describe(
        "The action to perform: 'get_storage' to retrieve localStorage or sessionStorage items, 'clear_storage' to clear storage, 'list_indexeddb' to list all IndexedDB databases and stores, or 'query_indexeddb' to query specific IndexedDB data."
      ),
      storage_type: z.enum(STORAGE_TYPES).optional().describe(
        "Optional. The type of storage to inspect: 'localStorage', 'sessionStorage', or 'indexedDB'. Required for 'get_storage' and 'clear_storage' actions."
      ),
      key_pattern: z.string().optional().describe(
        "Optional. Filter items by key pattern (regex or substring match). Use to focus on specific keys or search for patterns."
      ),
      page: z.number().int().nonnegative().optional().describe(
        "Optional. Page number for pagination (0-based). Defaults to 0."
      ),
      page_size: z.number().int().positive().optional().describe(
        "Optional. Number of items per page. Defaults to 50. Use for pagination of large datasets."
      ),
      db_name: z.string().optional().describe(
        "Optional. The name of the IndexedDB database. Required for 'query_indexeddb' action."
      ),
      store_name: z.string().optional().describe(
        "Optional. The name of the object store within the IndexedDB database. Required for 'query_indexeddb' action."
      ),
      window_label: z.string().optional().describe(
        "Optional. The identifier of the application window to inspect. Defaults to 'main' if not specified."
      ),
    },
    {
      title: "Inspect Browser Storage (localStorage, sessionStorage, IndexedDB)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({
      action,
      storage_type,
      key_pattern,
      page,
      page_size,
      db_name,
      store_name,
      window_label,
    }) => {
      try {
        // Validate required parameters
        if (!action) {
          return createErrorResponse("The action parameter is required");
        }

        // Validate actions that require storage_type
        if ((action === "get_storage" || action === "clear_storage") && !storage_type) {
          return createErrorResponse(
            `The storage_type parameter is required for the '${action}' action`
          );
        }

        // Validate query_indexeddb requires db_name and store_name
        if (action === "query_indexeddb" && (!db_name || !store_name)) {
          return createErrorResponse(
            "The db_name and store_name parameters are required for 'query_indexeddb' action"
          );
        }

        // Use default window label if not provided
        const effectiveWindowLabel = window_label || "main";

        // Build parameters object
        const params = {
          action,
          storage_type: storage_type || null,
          key_pattern: key_pattern || null,
          page: page ?? 0,
          page_size: page_size ?? 50,
          db_name: db_name || null,
          store_name: store_name || null,
          window_label: effectiveWindowLabel,
        };

        logCommandParams("storage_inspector", params);

        const result = await socketClient.sendCommand("storage_inspector", params);

        console.error(`Got storage inspector result: ${typeof result}`);

        // Format the result for display
        if (typeof result === "object" && result) {
          // Handle different response types
          if ("items" in result) {
            // localStorage/sessionStorage response
            const storageData = result as {
              storage_type: string;
              items: Array<{ key: string; value: unknown; size_bytes: number }>;
              total_items: number;
              total_size_bytes: number;
              paginated: boolean;
              page: number;
              page_size: number;
            };

            let output = `Storage Type: ${storageData.storage_type}\n`;
            output += `Total Items: ${storageData.total_items}\n`;
            output += `Total Size: ${formatBytes(storageData.total_size_bytes)}\n`;

            if (storageData.paginated) {
              output += `Page: ${storageData.page + 1} (${storageData.page_size} items per page)\n`;
            }

            output += `\n--- Items ---\n`;

            if (storageData.items.length === 0) {
              output += "No items found.";
            } else {
              storageData.items.forEach((item, index) => {
                output += `\n[${index + 1}] Key: ${item.key}\n`;
                output += `    Size: ${formatBytes(item.size_bytes)}\n`;
                const valueStr = typeof item.value === "string" ? item.value : JSON.stringify(item.value);
                const truncatedValue = valueStr.length > 200 ? valueStr.substring(0, 200) + "..." : valueStr;
                output += `    Value: ${truncatedValue}\n`;
              });
            }

            return createSuccessResponse(output);
          } else if ("databases" in result) {
            // IndexedDB list response
            const idbData = result as {
              databases: Array<{
                name: string;
                version: number;
                stores: Array<{
                  name: string;
                  key_path: unknown;
                  auto_increment: boolean;
                  indexes: string[];
                  item_count: number;
                }>;
              }>;
              items_by_store: Record<string, Array<{ key: string; value: unknown; size_bytes: number }>>;
              total_items: number;
              total_size_bytes: number;
            };

            let output = "=== IndexedDB Databases ===\n";
            output += `Total Databases: ${idbData.databases.length}\n`;
            output += `Total Items Across All Stores: ${idbData.total_items}\n`;
            output += `Total Size: ${formatBytes(idbData.total_size_bytes)}\n\n`;

            idbData.databases.forEach((db) => {
              output += `Database: ${db.name} (v${db.version})\n`;
              output += `  Stores: ${db.stores.length}\n`;
              db.stores.forEach((store) => {
                output += `    - ${store.name}\n`;
                output += `      Key Path: ${store.key_path ? JSON.stringify(store.key_path) : "none"}\n`;
                output += `      Auto Increment: ${store.auto_increment}\n`;
                output += `      Items: ${store.item_count}\n`;
                if (store.indexes.length > 0) {
                  output += `      Indexes: ${store.indexes.join(", ")}\n`;
                }
              });
              output += "\n";
            });

            // Show items if available
            const storeKeys = Object.keys(idbData.items_by_store);
            if (storeKeys.length > 0) {
              output += "--- Items by Store ---\n";
              storeKeys.forEach((storeName) => {
                const items = idbData.items_by_store[storeName];
                output += `\n[${storeName}] - ${items.length} items\n`;
                items.slice(0, 10).forEach((item, idx) => {
                  const valueStr = typeof item.value === "string" ? item.value : JSON.stringify(item.value);
                  const truncatedValue = valueStr.length > 100 ? valueStr.substring(0, 100) + "..." : valueStr;
                  output += `  ${idx + 1}. ${item.key}: ${truncatedValue} (${formatBytes(item.size_bytes)})\n`;
                });
                if (items.length > 10) {
                  output += `  ... and ${items.length - 10} more items\n`;
                }
              });
            }

            return createSuccessResponse(output);
          }

          // Default JSON formatting for other responses
          return createSuccessResponse(JSON.stringify(result, null, 2));
        }

        return createSuccessResponse(String(result));
      } catch (error) {
        console.error("storage_inspector error:", error);
        return createErrorResponse(
          `Failed to inspect storage: ${(error as Error).message}`
        );
      }
    }
  );
}

// Helper function to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
