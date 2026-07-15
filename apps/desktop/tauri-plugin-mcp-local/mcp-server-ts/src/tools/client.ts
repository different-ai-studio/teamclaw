import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';

// Constants
const SOCKET_FILENAME = 'tauri-mcp.sock';
const DEFAULT_SOCKET_PATH = `/private/tmp/${SOCKET_FILENAME}`;

// Connection configuration types
export interface IpcConfig {
  type: 'ipc';
  path?: string;
}

export interface TcpConfig {
  type: 'tcp';
  host: string;
  port: number;
}

export type ConnectionConfig = IpcConfig | TcpConfig;

// Socket client for Tauri IPC/TCP
export class TauriSocketClient {
  private config: ConnectionConfig;
  private client: net.Socket | null = null;
  private isConnected = false;
  private responseCallbacks: Map<string, { resolve: (value: any) => void, reject: (reason: any) => void }> = new Map();
  private buffer = '';
  private reconnectAttempts = 0;

  constructor(config?: ConnectionConfig) {
    // Default to IPC with default path
    this.config = config || { type: 'ipc', path: DEFAULT_SOCKET_PATH };
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    
    return new Promise((resolve, reject) => {
      let connectionOptions: net.NetConnectOpts;
      let connectionInfo: string;

      if (this.config.type === 'tcp') {
        // TCP connection
        connectionOptions = {
          host: this.config.host,
          port: this.config.port
        };
        connectionInfo = `TCP ${this.config.host}:${this.config.port}`;
      } else {
        // IPC connection
        let connectionPath = this.config.path || DEFAULT_SOCKET_PATH;
        
        // On Windows, the socket is created as a named pipe in a specific location
        if (os.platform() === 'win32') {
          connectionPath = `\\\\.\\pipe\\tmp\\${SOCKET_FILENAME}`;
          console.error(`Using Windows-specific pipe path: ${connectionPath}`);
        }
        
        connectionOptions = { path: connectionPath };
        connectionInfo = `IPC ${connectionPath}`;
      }

      console.error(`Connecting to ${connectionInfo} (attempt ${this.reconnectAttempts + 1})`);
      
      this.client = net.createConnection(connectionOptions, () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.error(`Connected to Tauri socket server at ${connectionInfo}`);
        
        // Setup data handler
        this.client!.on('data', (data) => {
          this.handleData(data);
        });
        
        resolve();
      });

      this.client!.on('error', (err) => {
        console.error('Socket connection error:', err);
        this.isConnected = false;
        reject(err);
      });
      
      this.client!.on('close', () => {
        this.isConnected = false;
        console.error('Socket connection closed');
        
        // Try to reconnect if not too many attempts
        if (this.reconnectAttempts < 3) {
          this.reconnectAttempts++;
          console.error(`Socket closed. Attempting to reconnect in 2 seconds...`);
          setTimeout(() => {
            this.connect().catch(e => {
              console.error('Reconnection failed:', e);
            });
          }, 2000);
        }
      });
    });
  }
  
  private handleData(data: Buffer) {
    // Accumulate data in the buffer
    this.buffer += data.toString();
    
    console.error(`Received ${data.length} bytes, buffer size: ${this.buffer.length}`);
    
    // Try to find complete JSON responses that end with newline
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const jsonStr = this.buffer.substring(0, newlineIndex);
      this.buffer = this.buffer.substring(newlineIndex + 1);
      
      console.error(`Processing JSON response of ${jsonStr.length} bytes`);
      
      try {
        const response = JSON.parse(jsonStr);
        
        // Process all matching callbacks that might be waiting for this response
        // Rather than just taking the first one, match based on timestamps (oldest first)
        const callbackIds = Array.from(this.responseCallbacks.keys());
        
        if (callbackIds.length > 0) {
          // Sort by timestamp (assuming IDs start with timestamp)
          callbackIds.sort();
          const callbackId = callbackIds[0];
          
          const callback = this.responseCallbacks.get(callbackId);
          if (callback) {
            // Remove the callback before invoking to prevent double calls
            this.responseCallbacks.delete(callbackId);
            
            if (!response.success) {
              // If the server indicates failure, reject the promise with the error message
              const errorMsg = response.error || 'Command failed without specific error';
              console.error(`Command failed with error: ${errorMsg}`);
              callback.reject(new Error(errorMsg));
            } else {
              callback.resolve(response.data);
            }
          }
        } else {
          console.error('Received response but no callbacks were waiting for it');
        }
      } catch (err) {
        console.error('Error parsing response:', err);
        
        // Log first and last 100 characters of the JSON string for debugging
        if (jsonStr.length > 200) {
          console.error(`JSON starts with: ${jsonStr.substring(0, 100)}...`);
          console.error(`JSON ends with: ...${jsonStr.substring(jsonStr.length - 100)}`);
        } else {
          console.error(`Full JSON: ${jsonStr}`);
        }
        
        // If parsing failed, this could be a partial message
        // so we'll just add it back to the buffer and wait for more data
        // But if it's too large (>10MB), something is wrong, so clear it
        if (this.buffer.length > 10_000_000) {
          console.error('Buffer overflow, clearing buffer');
          this.buffer = '';
          
          // Reject any pending callbacks
          for (const [id, callback] of this.responseCallbacks.entries()) {
            callback.reject(new Error('Buffer overflow'));
            this.responseCallbacks.delete(id);
          }
        }
      }
    }
  }

  async sendCommand(command: string, payload: Record<string, any> | string = {}): Promise<any> {
    if (!this.isConnected) {
      try {
        await this.connect();
      } catch (error) {
        throw new Error(`Failed to connect to socket server: ${(error as Error).message}`);
      }
    }

    if (!this.client) {
      throw new Error('Socket client not initialized');
    }

    return new Promise((resolve, reject) => {
      // Handle both string and object payloads
      let finalPayload: Record<string, any>;
      
      if (typeof payload === 'string') {
        // If payload is a string, send it as a special value that the server will recognize
        finalPayload = { window_label: payload };
        console.error(`Sending string payload as window_label: ${payload}`);
      } else {
        // If payload is an object, use it as is
        finalPayload = payload;
      }
      
      const request = JSON.stringify({
        command,
        payload: finalPayload
      }) + '\n';

      // Generate a unique ID for this request including timestamp for ordering
      const requestId = Date.now().toString() + Math.random().toString(36).substring(2);
      this.responseCallbacks.set(requestId, { resolve, reject });

      // Log the request
      console.error(`Sending request: ${command} with payload: ${JSON.stringify(finalPayload)}`);
      
      // Send the request
      this.client!.write(request, (err) => {
        if (err) {
          console.error(`Error writing to socket: ${err.message}`);
          this.responseCallbacks.delete(requestId);
          reject(new Error(`Failed to send request: ${err.message}`));
        }
      });
      
      // Set a timeout to prevent hanging if response never comes
      setTimeout(() => {
        if (this.responseCallbacks.has(requestId)) {
          this.responseCallbacks.delete(requestId);
          reject(new Error('Request timed out after 30 seconds'));
        }
      }, 30000);
    });
  }
}

// Create a singleton instance based on environment variables or defaults
function createSocketClient(): TauriSocketClient {
  // Check for environment variables to configure connection
  const connectionType = process.env.TAURI_MCP_CONNECTION_TYPE;
  
  if (connectionType === 'tcp') {
    const host = process.env.TAURI_MCP_TCP_HOST || '127.0.0.1';
    const port = parseInt(process.env.TAURI_MCP_TCP_PORT || '9999', 10);
    
    console.error(`Creating TCP socket client: ${host}:${port}`);
    return new TauriSocketClient({
      type: 'tcp',
      host,
      port
    });
  } else {
    // Default to IPC
    const path = process.env.TAURI_MCP_IPC_PATH;
    console.error(`Creating IPC socket client: ${path || 'default path'}`);
    return new TauriSocketClient({
      type: 'ipc',
      path
    });
  }
}

// Export a singleton instance
export const socketClient = createSocketClient(); 