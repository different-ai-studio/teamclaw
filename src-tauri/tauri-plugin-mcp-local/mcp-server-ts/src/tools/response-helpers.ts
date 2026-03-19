/**
 * Common response helper functions for MCP tool implementations
 */

/**
 * Creates a standardized error response
 * 
 * @param message Error message to display
 * @returns Properly formatted error response object
 */
export function createErrorResponse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Creates a standardized success response with text content
 * 
 * @param text Success message or result to display
 * @returns Properly formatted success response object
 */
export function createSuccessResponse(text: string) {
  return {
    isError: false,
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Creates a standardized success response with image content
 * 
 * @param base64Data Base64-encoded image data
 * @param mimeType MIME type of the image (default: 'image/jpeg')
 * @returns Properly formatted success response with image
 */
export function createImageResponse(base64Data: string, mimeType: string = 'image/jpeg') {
  return {
    isError: false,
    content: [{ 
      type: "image" as const, 
      data: base64Data,
      mimeType
    }],
  };
}

/**
 * Helper to safely extract base64 data from various response formats
 * 
 * @param result Result object from command
 * @returns Extracted base64 data or null if not found
 */
export function extractBase64Data(result: unknown): string | null {
  if (typeof result === 'string') {
    // Direct base64 string
    return result.startsWith('data:image') 
      ? result.split(',')[1]  // Remove the data URL prefix if present
      : result;
  } else if (result && typeof result === 'object') {
    // Check for data field in response object
    const obj = result as Record<string, any>;
    
    if (obj.data) {
      if (typeof obj.data === 'string') {
        return obj.data.startsWith('data:image')
          ? obj.data.split(',')[1]
          : obj.data;
      } else if (obj.data.data && typeof obj.data.data === 'string') {
        // Handle nested data structure
        return obj.data.data.startsWith('data:image')
          ? obj.data.data.split(',')[1]
          : obj.data.data;
      }
    }
  }
  
  return null;
}

/**
 * Format result from command as text, handling different types
 * 
 * @param result Result from command execution
 * @returns Formatted text representation
 */
export function formatResultAsText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  } else {
    return JSON.stringify(result, null, 2);
  }
}

/**
 * Helper to log parameters for debugging purposes
 * 
 * @param commandName Name of the command being executed
 * @param params Parameters being sent to the command
 */
export function logCommandParams(commandName: string, params: Record<string, any>): void {
  // Handle special case for code to prevent huge logs
  if (params.code && typeof params.code === 'string') {
    params = {
      ...params,
      code: params.code.substring(0, 100) + (params.code.length > 100 ? '...' : '')
    };
  }
  
  console.error(`Executing ${commandName} with params: ${JSON.stringify(params)}`);
} 