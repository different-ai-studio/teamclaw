import { emit } from '@tauri-apps/api/event'; // For emitting the response
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'; // For window-specific listener

// Track the unlisten functions for cleanup
let domContentUnlistenFunction: (() => void) | null = null;
let localStorageUnlistenFunction: (() => void) | null = null;
let jsExecutionUnlistenFunction: (() => void) | null = null;
let elementPositionUnlistenFunction: (() => void) | null = null;
let sendTextToElementUnlistenFunction: (() => void) | null = null;
let getNetworkRequestsUnlistenFunction: (() => void) | null = null;
let injectNetworkCaptureUnlistenFunction: (() => void) | null = null;
let getExceptionsUnlistenFunction: (() => void) | null = null;
let injectErrorTrackerUnlistenFunction: (() => void) | null = null;
let clearExceptionsUnlistenFunction: (() => void) | null = null;
let inspectStorageUnlistenFunction: (() => void) | null = null;

// Network request tracking
interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  request_type: string;
  status_code?: number;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
  request_body?: string;
  response_body?: string;
  error?: string;
  start_time_ms: number;
  end_time_ms?: number;
  duration_ms?: number;
}

const networkRequests: Map<string, NetworkRequest> = new Map();
let networkCaptureActive = false;
const MAX_REQUESTS = 500; // Circular buffer limit

// Exception/Error tracking
interface StackFrame {
  function_name?: string;
  file_name?: string;
  line_number?: number;
  column_number?: number;
  source_mapped_file?: string;
  source_mapped_line?: number;
  source_mapped_column?: number;
}

interface ExceptionEntry {
  id: string;
  error_type: string; // "uncaught", "unhandledrejection", "reactboundary"
  message: string;
  stack_trace: StackFrame[];
  first_occurrence_ms: number;
  last_occurrence_ms: number;
  frequency: number;
  error_details?: string;
}

const exceptions: Map<string, ExceptionEntry> = new Map();
let errorTrackerActive = false;
let circularBufferSize = 1000;

export async function setupPluginListeners() {
    const currentWindow: WebviewWindow = getCurrentWebviewWindow();
    domContentUnlistenFunction = await currentWindow.listen('got-dom-content', handleDomContentRequest);
    localStorageUnlistenFunction = await currentWindow.listen('get-local-storage', handleLocalStorageRequest);
    jsExecutionUnlistenFunction = await currentWindow.listen('execute-js', handleJsExecutionRequest);
    elementPositionUnlistenFunction = await currentWindow.listen('get-element-position', handleGetElementPositionRequest);
    sendTextToElementUnlistenFunction = await currentWindow.listen('send-text-to-element', handleSendTextToElementRequest);
    getNetworkRequestsUnlistenFunction = await currentWindow.listen('get-network-requests', handleGetNetworkRequestsRequest);
    injectNetworkCaptureUnlistenFunction = await currentWindow.listen('inject-network-capture', handleInjectNetworkCapture);
    getExceptionsUnlistenFunction = await currentWindow.listen('get-exceptions', handleGetExceptionsRequest);
    injectErrorTrackerUnlistenFunction = await currentWindow.listen('inject-error-tracker', handleInjectErrorTracker);
    clearExceptionsUnlistenFunction = await currentWindow.listen('clear-exceptions', handleClearExceptions);
    inspectStorageUnlistenFunction = await currentWindow.listen('inspect-storage', handleInspectStorageRequest);

    console.log('TAURI-PLUGIN-MCP: Event listeners for "got-dom-content", "get-local-storage", "execute-js", "get-element-position", "send-text-to-element", network inspection, error tracking, and storage inspection are set up on the current window.');
}

export async function cleanupPluginListeners() {
    if (domContentUnlistenFunction) {
        domContentUnlistenFunction();
        domContentUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "got-dom-content" has been removed.');
    }

    if (localStorageUnlistenFunction) {
        localStorageUnlistenFunction();
        localStorageUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-local-storage" has been removed.');
    }

    if (jsExecutionUnlistenFunction) {
        jsExecutionUnlistenFunction();
        jsExecutionUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "execute-js" has been removed.');
    }

    if (elementPositionUnlistenFunction) {
        elementPositionUnlistenFunction();
        elementPositionUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-element-position" has been removed.');
    }

    if (sendTextToElementUnlistenFunction) {
        sendTextToElementUnlistenFunction();
        sendTextToElementUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "send-text-to-element" has been removed.');
    }

    if (getNetworkRequestsUnlistenFunction) {
        getNetworkRequestsUnlistenFunction();
        getNetworkRequestsUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-network-requests" has been removed.');
    }

    if (injectNetworkCaptureUnlistenFunction) {
        injectNetworkCaptureUnlistenFunction();
        injectNetworkCaptureUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "inject-network-capture" has been removed.');
    }

    if (getExceptionsUnlistenFunction) {
        getExceptionsUnlistenFunction();
        getExceptionsUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-exceptions" has been removed.');
    }

    if (injectErrorTrackerUnlistenFunction) {
        injectErrorTrackerUnlistenFunction();
        injectErrorTrackerUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "inject-error-tracker" has been removed.');
    }

    if (clearExceptionsUnlistenFunction) {
        clearExceptionsUnlistenFunction();
        clearExceptionsUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "clear-exceptions" has been removed.');
    }

    if (inspectStorageUnlistenFunction) {
        inspectStorageUnlistenFunction();
        inspectStorageUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "inspect-storage" has been removed.');
    }

    // Stop network capture
    networkCaptureActive = false;

    // Stop error tracking
    errorTrackerActive = false;
}

async function handleGetElementPositionRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-element-position, payload:', event.payload);

    try {
        const { selectorType, selectorValue, shouldClick = false } = event.payload;

        // Find the element based on the selector type
        let element = null;
        let debugInfo = [];

        switch (selectorType) {
            case 'id':
                element = document.getElementById(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with id="${selectorValue}"`);
                }
                break;
            case 'class':
                // Get the first element with the class
                const elemsByClass = document.getElementsByClassName(selectorValue);
                element = elemsByClass.length > 0 ? elemsByClass[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with class="${selectorValue}" (total matching: 0)`);
                } else if (elemsByClass.length > 1) {
                    debugInfo.push(`Found ${elemsByClass.length} elements with class="${selectorValue}", using the first one`);
                }
                break;
            case 'tag':
                // Get the first element with the tag name
                const elemsByTag = document.getElementsByTagName(selectorValue);
                element = elemsByTag.length > 0 ? elemsByTag[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with tag="${selectorValue}" (total matching: 0)`);
                } else if (elemsByTag.length > 1) {
                    debugInfo.push(`Found ${elemsByTag.length} elements with tag="${selectorValue}", using the first one`);
                }
                break;
            case 'text':
                // Find element by text content
                element = findElementByText(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with text="${selectorValue}"`);
                    // Check if any element contains part of the text (for debugging)
                    const containingElements = Array.from(document.querySelectorAll('*'))
                        .filter(el => el.textContent && el.textContent.includes(selectorValue));

                    if (containingElements.length > 0) {
                        debugInfo.push(`Found ${containingElements.length} element(s) containing the text`);
                    }
                }
                break;
            case 'xpath':
                // Use XPath to find element
                try {
                    const result = document.evaluate(selectorValue, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    element = result.singleNodeValue as HTMLElement;
                    if (!element) {
                        debugInfo.push(`No element found with XPath="${selectorValue}"`);
                    }
                } catch (err) {
                    debugInfo.push(`Invalid XPath: "${selectorValue}", error: ${err}`);
                }
                break;
            case 'css':
            default:
                // Use CSS selector
                try {
                    element = document.querySelector(selectorValue);
                    if (!element) {
                        const elements = document.querySelectorAll(selectorValue);
                        if (elements.length > 1) {
                            debugInfo.push(`Found ${elements.length} elements with selector="${selectorValue}", using the first one`);
                            element = elements[0] as HTMLElement;
                        } else {
                            debugInfo.push(`No elements found with selector="${selectorValue}"`);
                        }
                    }
                } catch (err) {
                    debugInfo.push(`Invalid CSS selector: "${selectorValue}", error: ${err}`);
                }
                break;
        }

        if (!element) {
            console.error('TAURI-PLUGIN-MCP: Element not found with selector:', selectorValue);

            const currentWindow: WebviewWindow = getCurrentWebviewWindow();
            try {
                await currentWindow.emit('get-element-position-response', {
                    success: false,
                    error: `Element not found. Debug info: ${debugInfo.join('; ')}`,
                });
            } catch (e) {
                console.error('TAURI-PLUGIN-MCP: Error emitting error response', e);
            }
            return;
        }

        const rect = element.getBoundingClientRect();

        console.log('TAURI-PLUGIN-MCP: Element rect:', {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
        });

        if (shouldClick) {
            console.log('TAURI-PLUGIN-MCP: Clicking element at', { x: rect.x, y: rect.y });

            // Trigger click
            element.click();
        }

        const targetX = rect.left + rect.width / 2;
        const targetY = rect.top + rect.height / 2;

        console.log('TAURI-PLUGIN-MCP: Raw coordinates for mouse_movement:', { x: targetX, y: targetY });

        const currentWindow: WebviewWindow = getCurrentWebviewWindow();
        try {
            await currentWindow.emit('get-element-position-response', {
                x: Math.round(targetX),
                y: Math.round(targetY),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            });
        } catch (e) {
            console.error('TAURI-PLUGIN-MCP: Error emitting response', e);
        }
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling get-element-position request', error);

        const currentWindow: WebviewWindow = getCurrentWebviewWindow();
        currentWindow.emit('get-element-position-response', {
            success: false,
            error: `Error occurred: ${error}`,
        }).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

async function handleDomContentRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received got-dom-content, payload:', event.payload);

    try {
        const domContent = getDomContentRecursive(document.documentElement, 10000);
        const currentWindow: WebviewWindow = getCurrentWebviewWindow();
        await currentWindow.emit('got-dom-content-response', { domContent });
        console.log('TAURI-PLUGIN-MCP: Emitted got-dom-content-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling dom content request', error);

        const currentWindow: WebviewWindow = getCurrentWebviewWindow();
        currentWindow.emit('got-dom-content-response', {
            domContent: ''
        }).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting empty response', e));
    }
}

// Helper to get DOM content recursively
function getDomContentRecursive(element: Element, charLimit: number): string {
    if (charLimit <= 0) {
        return '<!-- Content truncated -->'; // Return indication that content was truncated
    }

    const domSerializer = new XMLSerializer();
    const domContent = domSerializer.serializeToString(element);

    console.log('TAURI-PLUGIN-MCP: DOM content fetched, length:', domContent.length);

    // If the DOM is already smaller than the limit, return the entire content
    if (domContent.length <= charLimit) {
        return domContent;
    }

    // Truncate to the character limit
    const truncatedContent = domContent.slice(0, charLimit) + '<!-- Content truncated -->';
    return truncatedContent;
}

if (document.readyState === 'loading') {
    console.warn('TAURI-PLUGIN-MCP: DOM not fully loaded when got-dom-content received. Returning empty content.');
}

async function handleLocalStorageRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-local-storage, payload:', event.payload);

    const currentWindow: WebviewWindow = getCurrentWebviewWindow();

    const storage: { [key: string]: string | object } = {};

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
            try {
                const value = localStorage.getItem(key);
                try {
                    // Try to parse as JSON
                    storage[key] = JSON.parse(value!);
                } catch {
                    console.log('TAURI-PLUGIN-MCP: Key not valid JSON, using as string');
                    storage[key] = value!;
                }
            } catch (e) {
                console.error('TAURI-PLUGIN-MCP: Error reading localStorage key:', key, e);
            }
        }
    }

    try {
        await currentWindow.emit('get-local-storage-response', storage);
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error emitting get-local-storage-response', e);
    }
}

async function handleJsExecutionRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received execute-js, payload:', event.payload);

    const currentWindow: WebviewWindow = getCurrentWebviewWindow();

    const { code } = event.payload;
    try {
        // eslint-disable-next-line no-eval
        const result = (0, eval)(code);
        await currentWindow.emit('execute-js-response', {
            success: true,
            result: typeof result === 'object' ? JSON.stringify(result) : String(result)
        });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error executing JS:', error);
        await currentWindow.emit('execute-js-response', {
            success: false,
            error: String(error)
        });
    }
}

async function handleSendTextToElementRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received send-text-to-element, payload:', event.payload);

    const currentWindow: WebviewWindow = getCurrentWebviewWindow();

    try {
        const { selectorType, selectorValue, text, delayMs = 0 } = event.payload;

        // Find the element
        let element = null;

        switch (selectorType) {
            case 'id':
                element = document.getElementById(selectorValue);
                break;
            case 'class':
                const elemsByClass = document.getElementsByClassName(selectorValue);
                element = elemsByClass.length > 0 ? (elemsByClass[0] as HTMLElement) : null;
                break;
            case 'tag':
                const elemsByTag = document.getElementsByTagName(selectorValue);
                element = elemsByTag.length > 0 ? (elemsByTag[0] as HTMLElement) : null;
                break;
            case 'text':
                element = findElementByText(selectorValue);
                break;
            case 'xpath':
                try {
                    const result = document.evaluate(selectorValue, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    element = result.singleNodeValue as HTMLElement;
                } catch (err) {
                    throw new Error(`Invalid XPath: "${selectorValue}"`);
                }
                break;
            case 'css':
            default:
                element = document.querySelector(selectorValue) as HTMLElement;
                break;
        }

        if (!element) {
            throw new Error(`Element not found: ${selectorValue}`);
        }

        // Determine if this is a Lexical or Slate editor
        const isLexicalEditor = element.closest('[data-testid="lexical-editor"]') || element.closest('[data-type="editor"]');
        const isSlateEditor = element.closest('[data-slate-editor="true"]') || element.className?.includes('slate');

        if (isLexicalEditor) {
            await typeIntoLexicalEditor(element as HTMLElement, text, delayMs);
        } else if (isSlateEditor) {
            await typeIntoSlateEditor(element as HTMLElement, text, delayMs);
        } else {
            // Standard input/textarea handling
            await typeIntoElement(element as HTMLElement, text, delayMs);
        }

        await currentWindow.emit('send-text-to-element-response', { success: true });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling send-text-to-element request', error);

        await currentWindow.emit('send-text-to-element-response', {
            success: false,
            error: String(error)
        });
    }
}

// Helper function to find element by text content
function findElementByText(text: string): HTMLElement | null {
    const elements = document.querySelectorAll('*');
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.textContent === text) {
            return element as HTMLElement;
        }
    }
    return null;
}

// Helper function for standard element typing
async function typeIntoElement(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    // Focus the element
    element.focus();

    // Get the input/textarea if clicking on a label or container
    let targetElement = element;
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        const input = element.querySelector('input, textarea') as HTMLElement;
        if (input) {
            targetElement = input;
        }
    }

    // Clear existing content for inputs and textareas
    if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) {
        targetElement.value = '';
    } else {
        targetElement.textContent = '';
    }

    // Type each character with delay
    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) {
            targetElement.value += char;
            targetElement.dispatchEvent(new Event('input', { bubbles: true }));
            targetElement.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            targetElement.textContent += char;
        }

        // Delay between characters
        if (delayMs > 0 && i < text.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// Helper function specifically for Lexical Editor
async function typeIntoLexicalEditor(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Starting specialized Lexical editor typing');

    try {
        // Focus the element
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 100));

        // Find the actual editable div in Lexical editor
        const editableDiv = element.querySelector('[contenteditable="true"]') || element;
        if (editableDiv instanceof HTMLElement) {
            editableDiv.focus();
        }

        // Clear existing content
        if (editableDiv instanceof HTMLElement) {
            editableDiv.textContent = '';
            editableDiv.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }

        // Type each character
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Dispatch keyboard events
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
                key: char,
                bubbles: true,
                cancelable: true
            }));

            if (editableDiv instanceof HTMLElement) {
                editableDiv.textContent = (editableDiv.textContent || '') + char;
                editableDiv.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText'
                }));
            }

            document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', {
                key: char,
                bubbles: true,
                cancelable: true
            }));

            // Delay between characters
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        console.log('TAURI-PLUGIN-MCP: Completed Lexical editor typing');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in Lexical editor typing:', e);

        // Last resort fallback - try to set content directly
        try {
            const firstParagraph = element.querySelector('p') || element;
            firstParagraph.textContent = text;
            element.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch (innerError) {
            console.error('TAURI-PLUGIN-MCP: Fallback for Lexical editor failed:', innerError);
        }
    }
}

// Helper function specifically for Slate Editor
async function typeIntoSlateEditor(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Starting specialized Slate editor typing');

    try {
        // Focus the element
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 100));

        // Find the actual editable div in Slate editor
        const editableDiv = element.querySelector('[contenteditable="true"]') || element;
        if (editableDiv instanceof HTMLElement) {
            editableDiv.focus();
        }

        // For Slate, we'll try the execCommand approach which is often more reliable
        document.execCommand('selectAll', false, undefined);
        document.execCommand('delete', false, undefined);
        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate typing with proper events
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Ensure we're targeting the active element (Slate may change focus)
            const activeElement = document.activeElement || editableDiv;

            // Key events sequence
            activeElement.dispatchEvent(new KeyboardEvent('keydown', {
                key: char,
                bubbles: true,
                cancelable: true
            }));

            // Use execCommand for insertion
            document.execCommand('insertText', false, char);

            activeElement.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            }));

            activeElement.dispatchEvent(new KeyboardEvent('keyup', {
                key: char,
                bubbles: true,
                cancelable: true
            }));

            // Delay between characters
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        console.log('TAURI-PLUGIN-MCP: Completed Slate editor typing');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in Slate editor typing:', e);

        // Fallback approach
        try {
            const editableDiv = element.querySelector('[contenteditable="true"]') || element;
            editableDiv.textContent = text;
            editableDiv.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch (innerError) {
            console.error('TAURI-PLUGIN-MCP: Fallback for Slate editor failed:', innerError);
        }
    }
}

// Network inspection functions

function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function recordNetworkRequest(
    url: string,
    method: string,
    requestType: string,
    requestHeaders: Record<string, string>,
    requestBody?: string
): string {
    const id = generateRequestId();
    const request: NetworkRequest = {
        id,
        url,
        method: method.toUpperCase(),
        request_type: requestType,
        request_headers: requestHeaders || {},
        response_headers: {},
        request_body: requestBody,
        start_time_ms: Date.now(),
    };
    networkRequests.set(id, request);

    // Maintain circular buffer limit
    if (networkRequests.size > MAX_REQUESTS) {
        const firstKey = networkRequests.keys().next().value;
        if (firstKey) {
            networkRequests.delete(firstKey);
        }
    }

    return id;
}

function updateNetworkResponse(
    id: string,
    statusCode: number,
    responseHeaders: Record<string, string>,
    responseBody?: string
): void {
    const request = networkRequests.get(id);
    if (request) {
        request.status_code = statusCode;
        request.response_headers = responseHeaders || {};
        request.response_body = responseBody;
        request.end_time_ms = Date.now();
        request.duration_ms = request.end_time_ms - request.start_time_ms;
    }
}

function recordNetworkError(id: string, error: string): void {
    const request = networkRequests.get(id);
    if (request) {
        request.error = error;
        request.end_time_ms = Date.now();
        request.duration_ms = request.end_time_ms - request.start_time_ms;
    }
}

function interceptFetch(): void {
    const originalFetch = window.fetch;
    window.fetch = function(...args: any[]): Promise<Response> {
        const url = args[0]?.toString() || 'unknown';
        const options = args[1] || {};
        const method = (options.method || 'GET').toUpperCase();

        const requestHeaders: Record<string, string> = {};
        if (options.headers) {
            if (options.headers instanceof Headers) {
                options.headers.forEach((value: string, key: string) => {
                    requestHeaders[key.toLowerCase()] = value;
                });
            } else if (typeof options.headers === 'object') {
                Object.entries(options.headers).forEach(([key, value]) => {
                    requestHeaders[key.toLowerCase()] = String(value);
                });
            }
        }

        const requestBody = options.body ? String(options.body).substring(0, 10000) : undefined;
        const requestId = recordNetworkRequest(url, method, 'fetch', requestHeaders, requestBody);

        return originalFetch.apply(this, args)
            .then((response: Response) => {
                const responseHeaders: Record<string, string> = {};
                response.headers.forEach((value: string, key: string) => {
                    responseHeaders[key.toLowerCase()] = value;
                });

                // Try to clone and read response body
                const clonedResponse = response.clone();
                clonedResponse.text()
                    .then((body: string) => {
                        updateNetworkResponse(requestId, response.status, responseHeaders, body.substring(0, 10000));
                    })
                    .catch(() => {
                        updateNetworkResponse(requestId, response.status, responseHeaders);
                    });

                return response;
            })
            .catch((error: Error) => {
                recordNetworkError(requestId, error.message || 'Unknown fetch error');
                throw error;
            });
    };

    console.log('TAURI-PLUGIN-MCP: Fetch interceptor installed');
}

function interceptXHR(): void {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    let xhrRequestMap = new Map<XMLHttpRequest, string>();

    XMLHttpRequest.prototype.open = function(method: string, url: string, ...args: any[]): void {
        const requestHeaders: Record<string, string> = {};
        const requestId = recordNetworkRequest(url, method, 'xhr', requestHeaders);
        xhrRequestMap.set(this, requestId);
        return originalOpen.apply(this, [method, url, ...args]);
    };

    XMLHttpRequest.prototype.send = function(body?: any): void {
        const requestId = xhrRequestMap.get(this);
        const request = requestId ? networkRequests.get(requestId) : null;

        if (request && this.getAllResponseHeaders) {
            // Capture request headers set via setRequestHeader
            // Note: We can't directly access setRequestHeader calls, but we try to get common ones
            try {
                const auth = (this as any).getRequestHeader?.('Authorization');
                if (auth) request.request_headers['authorization'] = auth;
            } catch (e) {
                // Ignore errors
            }

            if (body) {
                request.request_body = String(body).substring(0, 10000);
            }
        }

        const originalOnReadyStateChange = this.onreadystatechange;
        this.onreadystatechange = function() {
            if (this.readyState === 4 && requestId) {
                const responseHeaders: Record<string, string> = {};
                const headerLines = this.getAllResponseHeaders().split('\r\n');
                headerLines.forEach((line: string) => {
                    const colonIndex = line.indexOf(':');
                    if (colonIndex > 0) {
                        const key = line.substring(0, colonIndex).trim().toLowerCase();
                        const value = line.substring(colonIndex + 1).trim();
                        responseHeaders[key] = value;
                    }
                });

                try {
                    const responseBody = this.responseText?.substring(0, 10000);
                    updateNetworkResponse(requestId, this.status, responseHeaders, responseBody);
                } catch (e) {
                    updateNetworkResponse(requestId, this.status, responseHeaders);
                }
            }

            if (originalOnReadyStateChange) {
                originalOnReadyStateChange.call(this);
            }
        };

        this.onerror = function() {
            if (requestId) {
                recordNetworkError(requestId, 'XHR request failed');
            }
        };

        return originalSend.apply(this, [body]);
    };

    console.log('TAURI-PLUGIN-MCP: XHR interceptor installed');
}

async function handleInjectNetworkCapture(event: any) {
    console.log('TAURI-PLUGIN-MCP: Injecting network capture');

    try {
        if (!networkCaptureActive) {
            interceptFetch();
            interceptXHR();
            networkCaptureActive = true;
            console.log('TAURI-PLUGIN-MCP: Network capture activated');
        }

        const currentWindow = getCurrentWebviewWindow();
        await emit('inject-network-capture-response', { success: true });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error injecting network capture', error);
        const currentWindow = getCurrentWebviewWindow();
        await emit('inject-network-capture-response', { error: String(error) });
    }
}

async function handleGetNetworkRequestsRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-network-requests, payload:', event.payload);

    try {
        const filter = event.payload || {};

        // Convert map to array and apply filters
        let requests = Array.from(networkRequests.values());

        // Filter by URL pattern
        if (filter.url_pattern) {
            try {
                const urlRegex = new RegExp(filter.url_pattern, 'i');
                requests = requests.filter(r => urlRegex.test(r.url));
            } catch (e) {
                // If regex fails, try substring match
                const pattern = filter.url_pattern.toLowerCase();
                requests = requests.filter(r => r.url.toLowerCase().includes(pattern));
            }
        }

        // Filter by method
        if (filter.method) {
            const method = filter.method.toUpperCase();
            requests = requests.filter(r => r.method === method);
        }

        // Filter by status code
        if (filter.status_code !== undefined) {
            requests = requests.filter(r => r.status_code === filter.status_code);
        }

        // Filter by duration
        if (filter.min_duration_ms !== undefined) {
            requests = requests.filter(r => r.duration_ms && r.duration_ms >= filter.min_duration_ms);
        }
        if (filter.max_duration_ms !== undefined) {
            requests = requests.filter(r => r.duration_ms && r.duration_ms <= filter.max_duration_ms);
        }

        // Filter by request type
        if (filter.request_type) {
            requests = requests.filter(r => r.request_type === filter.request_type);
        }

        // Filter by time range
        if (filter.start_time_ms !== undefined) {
            requests = requests.filter(r => r.start_time_ms >= filter.start_time_ms);
        }
        if (filter.end_time_ms !== undefined) {
            requests = requests.filter(r => r.start_time_ms <= filter.end_time_ms);
        }

        // Sort by start time descending (newest first)
        requests.sort((a, b) => b.start_time_ms - a.start_time_ms);

        // Apply limit
        const limit = filter.limit || 100;
        const paginatedRequests = requests.slice(0, limit);

        const currentWindow = getCurrentWebviewWindow();
        await emit('get-network-requests-response', {
            requests: paginatedRequests,
            total_count: requests.length,
            capture_active: networkCaptureActive,
        });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling network requests request', error);
        const currentWindow = getCurrentWebviewWindow();
        await emit('get-network-requests-response', {
            error: String(error),
            requests: [],
            total_count: 0,
            capture_active: networkCaptureActive,
        });
    }
}

// Error tracking functions
function parseStackTrace(stack: string | undefined): StackFrame[] {
    if (!stack) {
        return [];
    }

    const frames: StackFrame[] = [];
    const lines = stack.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Error') || trimmed === 'at') {
            continue;
        }

        // Parse stack frame (e.g., "at functionName (filename:line:column)")
        const atMatch = trimmed.match(/^at\s+(.+)\s+\((.+):(\d+):(\d+)\)$/);
        if (atMatch) {
            frames.push({
                function_name: atMatch[1],
                file_name: atMatch[2],
                line_number: parseInt(atMatch[3], 10),
                column_number: parseInt(atMatch[4], 10),
            });
        } else {
            // Try alternate format (e.g., "at filename:line:column")
            const altMatch = trimmed.match(/^at\s+(.+):(\d+):(\d+)$/);
            if (altMatch) {
                frames.push({
                    file_name: altMatch[1],
                    line_number: parseInt(altMatch[2], 10),
                    column_number: parseInt(altMatch[3], 10),
                });
            }
        }
    }

    return frames;
}

function generateExceptionId(): string {
    return `exc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function recordException(errorType: string, message: string, stack: string | undefined, errorDetails?: string): void {
    if (!errorTrackerActive) {
        return;
    }

    const stackFrames = parseStackTrace(stack);
    const now = Date.now();

    // Create a unique key for this exception based on type and message
    const exceptionKey = `${errorType}::${message}`;

    if (exceptions.has(exceptionKey)) {
        // Update existing exception entry
        const existing = exceptions.get(exceptionKey)!;
        existing.frequency += 1;
        existing.last_occurrence_ms = now;
    } else {
        // Create new exception entry
        const entry: ExceptionEntry = {
            id: generateExceptionId(),
            error_type: errorType,
            message,
            stack_trace: stackFrames,
            first_occurrence_ms: now,
            last_occurrence_ms: now,
            frequency: 1,
            error_details: errorDetails,
        };

        exceptions.set(exceptionKey, entry);

        // Enforce circular buffer limit
        if (exceptions.size > circularBufferSize) {
            // Remove the oldest exception
            const firstKey = exceptions.keys().next().value;
            if (firstKey) {
                exceptions.delete(firstKey);
            }
        }
    }

    console.log(`TAURI-PLUGIN-MCP: Exception recorded [${errorType}] ${message}`);
}

function installErrorTrackers(): void {
    // Capture uncaught exceptions via window.onerror
    (window as any).onerror = function(
        message: string | Event,
        source?: string,
        lineno?: number,
        colno?: number,
        error?: Error
    ): boolean {
        const errorMessage = typeof message === 'string' ? message : message.toString();
        const stack = error?.stack || `${source}:${lineno}:${colno}`;
        recordException('uncaught', errorMessage, stack);
        return false;
    };

    // Capture unhandled promise rejections
    (window as any).onunhandledrejection = function(event: PromiseRejectionEvent): void {
        const reason = event.reason || 'Unknown rejection reason';
        const message = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : undefined;
        recordException('unhandledrejection', message, stack, String(reason));
    };

    console.log('TAURI-PLUGIN-MCP: Error trackers installed');
}

async function handleInjectErrorTracker(event: any) {
    console.log('TAURI-PLUGIN-MCP: Injecting error tracker');

    try {
        const payload = event.payload || {};
        circularBufferSize = payload.circular_buffer_size || 1000;

        if (!errorTrackerActive) {
            installErrorTrackers();
            errorTrackerActive = true;
            console.log('TAURI-PLUGIN-MCP: Error tracking activated');
        }

        const currentWindow = getCurrentWebviewWindow();
        await emit('inject-error-tracker-response', { success: true });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error injecting error tracker', error);
        const currentWindow = getCurrentWebviewWindow();
        await emit('inject-error-tracker-response', { error: String(error) });
    }
}

async function handleGetExceptionsRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-exceptions, payload:', event.payload);

    try {
        const filter = event.payload || {};

        // Convert map to array
        let exceptionList = Array.from(exceptions.values());

        // Filter by error type
        if (filter.error_type && filter.error_type !== 'all') {
            exceptionList = exceptionList.filter(e => e.error_type === filter.error_type);
        }

        // Filter by message pattern
        if (filter.message_pattern) {
            try {
                const messageRegex = new RegExp(filter.message_pattern, 'i');
                exceptionList = exceptionList.filter(e => messageRegex.test(e.message));
            } catch (e) {
                // If regex fails, try substring match
                const pattern = filter.message_pattern.toLowerCase();
                exceptionList = exceptionList.filter(e => e.message.toLowerCase().includes(pattern));
            }
        }

        // Filter by time range
        if (filter.start_time_ms !== undefined) {
            exceptionList = exceptionList.filter(e => e.first_occurrence_ms >= filter.start_time_ms);
        }
        if (filter.end_time_ms !== undefined) {
            exceptionList = exceptionList.filter(e => e.first_occurrence_ms <= filter.end_time_ms);
        }

        // Sort by first occurrence descending (newest first)
        exceptionList.sort((a, b) => b.first_occurrence_ms - a.first_occurrence_ms);

        // Apply limit
        const limit = filter.limit || 100;
        const paginatedExceptions = exceptionList.slice(0, limit);

        const currentWindow = getCurrentWebviewWindow();
        await emit('get-exceptions-response', {
            exceptions: paginatedExceptions,
            total_count: exceptionList.length,
        });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling exceptions request', error);
        const currentWindow = getCurrentWebviewWindow();
        await emit('get-exceptions-response', {
            error: String(error),
            exceptions: [],
            total_count: 0,
        });
    }
}

async function handleClearExceptions(event: any) {
    console.log('TAURI-PLUGIN-MCP: Clearing exceptions');

    try {
        exceptions.clear();
        const currentWindow = getCurrentWebviewWindow();
        await emit('clear-exceptions-response', { success: true });
        console.log('TAURI-PLUGIN-MCP: Exceptions cleared');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error clearing exceptions', error);
        const currentWindow = getCurrentWebviewWindow();
        await emit('clear-exceptions-response', { error: String(error) });
    }
}

async function handleInspectStorageRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received inspect-storage, payload:', event.payload);

    const currentWindow: WebviewWindow = getCurrentWebviewWindow();
    const { action, storage_type, key_pattern, page, page_size, db_name, store_name } = event.payload;

    try {
        let result: any = { error: null, data: null };

        if (action === 'get_storage' && (storage_type === 'localStorage' || storage_type === 'sessionStorage')) {
            result = await getStorageData(storage_type as 'localStorage' | 'sessionStorage', key_pattern, page, page_size);
        } else if (action === 'clear_storage' && (storage_type === 'localStorage' || storage_type === 'sessionStorage')) {
            if (storage_type === 'localStorage') {
                localStorage.clear();
            } else {
                sessionStorage.clear();
            }
            result.data = { success: true, message: `${storage_type} cleared` };
        } else if (action === 'list_indexeddb') {
            result.data = await listIndexedDBDatabases();
        } else if (action === 'query_indexeddb' && db_name && store_name) {
            result.data = await queryIndexedDB(db_name, store_name, key_pattern, page, page_size);
        } else {
            result.error = `Unknown action or invalid parameters: ${action}`;
        }

        await currentWindow.emit('inspect-storage-response', result);
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling storage inspection:', error);
        await currentWindow.emit('inspect-storage-response', {
            error: String(error),
            data: null
        });
    }
}

async function getStorageData(
    storageType: 'localStorage' | 'sessionStorage',
    keyPattern?: string,
    page: number = 0,
    pageSize: number = 50
) {
    const storage = storageType === 'localStorage' ? localStorage : sessionStorage;
    const items: Array<{ key: string; value: any; size_bytes: number }> = [];

    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key) {
            // Check if key matches pattern
            if (keyPattern) {
                try {
                    const regex = new RegExp(keyPattern, 'i');
                    if (!regex.test(key)) continue;
                } catch (e) {
                    // Fallback to substring match
                    if (!key.toLowerCase().includes(keyPattern.toLowerCase())) continue;
                }
            }

            try {
                const value = storage.getItem(key);
                let parsedValue: any = value;
                try {
                    parsedValue = JSON.parse(value!);
                } catch {
                    // Keep as string if not JSON
                }

                const sizeBytes = new Blob([JSON.stringify(parsedValue)]).size;
                items.push({ key, value: parsedValue, size_bytes: sizeBytes });
            } catch (e) {
                console.error(`TAURI-PLUGIN-MCP: Error reading ${storageType} key: ${key}`, e);
            }
        }
    }

    // Apply pagination
    const totalItems = items.length;
    const paginatedItems = items.slice(page * pageSize, (page + 1) * pageSize);
    const totalSizeBytes = items.reduce((sum, item) => sum + item.size_bytes, 0);

    return {
        data: {
            storage_type: storageType,
            items: paginatedItems,
            total_items: totalItems,
            total_size_bytes: totalSizeBytes,
            paginated: totalItems > pageSize,
            page,
            page_size: pageSize
        }
    };
}

async function listIndexedDBDatabases() {
    const databases: any[] = [];
    const itemsByStore: Record<string, any[]> = {};

    try {
        // Get list of IndexedDB databases - requires browser support
        const dbList = await (indexedDB as any).databases?.() || [];

        for (const dbInfo of dbList) {
            const dbName = dbInfo.name;
            try {
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open(dbName);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                    request.onupgradeneeded = () => {
                        // Don't upgrade, just open
                    };
                });

                const storeNames = Array.from(db.objectStoreNames);
                const stores: any[] = [];

                for (const storeName of storeNames) {
                    const transaction = db.transaction([storeName], 'readonly');
                    const store = transaction.objectStore(storeName);

                    // Get key path and auto increment info
                    const keyPath = store.keyPath;
                    const autoIncrement = store.autoIncrement;
                    const indexNames = Array.from(store.indexNames);

                    // Count items in store
                    const countRequest = store.count();
                    const itemCount = await new Promise<number>((resolve, reject) => {
                        countRequest.onsuccess = () => resolve(countRequest.result);
                        countRequest.onerror = () => reject(countRequest.error);
                    });

                    stores.push({
                        name: storeName,
                        key_path: keyPath,
                        auto_increment: autoIncrement,
                        indexes: indexNames,
                        item_count: itemCount
                    });

                    // Sample data from store (first 50 items)
                    const getAllRequest = store.getAll();
                    const allItems = await new Promise<any[]>((resolve, reject) => {
                        getAllRequest.onsuccess = () => resolve(getAllRequest.result);
                        getAllRequest.onerror = () => reject(getAllRequest.error);
                    });

                    itemsByStore[storeName] = allItems.slice(0, 50).map((value, index) => ({
                        key: typeof keyPath === 'string' ? (value[keyPath] ?? index) : index,
                        value,
                        size_bytes: new Blob([JSON.stringify(value)]).size
                    }));
                }

                databases.push({
                    name: dbName,
                    version: db.version,
                    stores
                });

                db.close();
            } catch (error) {
                console.error(`TAURI-PLUGIN-MCP: Error opening IndexedDB ${dbName}:`, error);
            }
        }
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error listing IndexedDB databases:', error);
        // Continue gracefully - some browsers don't support indexedDB.databases()
    }

    const totalItems = Object.values(itemsByStore).reduce((sum, items) => sum + items.length, 0);
    const totalSizeBytes = Object.values(itemsByStore).reduce(
        (sum, items) => sum + items.reduce((s, item) => s + item.size_bytes, 0),
        0
    );

    return {
        databases,
        items_by_store: itemsByStore,
        total_items: totalItems,
        total_size_bytes: totalSizeBytes
    };
}

async function queryIndexedDB(
    dbName: string,
    storeName: string,
    keyPattern?: string,
    page: number = 0,
    pageSize: number = 50
) {
    try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);

        // Get all items
        const getAllRequest = store.getAll();
        const allItems = await new Promise<any[]>((resolve, reject) => {
            getAllRequest.onsuccess = () => resolve(getAllRequest.result);
            getAllRequest.onerror = () => reject(getAllRequest.error);
        });

        // Filter by key pattern if provided
        let items = allItems;
        if (keyPattern) {
            items = items.filter(item => {
                const keyStr = JSON.stringify(item).toLowerCase();
                try {
                    const regex = new RegExp(keyPattern, 'i');
                    return regex.test(keyStr);
                } catch (e) {
                    return keyStr.includes(keyPattern.toLowerCase());
                }
            });
        }

        // Apply pagination
        const totalItems = items.length;
        const paginatedItems = items.slice(page * pageSize, (page + 1) * pageSize);
        const totalSizeBytes = items.reduce((sum, item) => sum + new Blob([JSON.stringify(item)]).size, 0);

        // Map to items format
        const formattedItems = paginatedItems.map((value, index) => ({
            key: index,
            value,
            size_bytes: new Blob([JSON.stringify(value)]).size
        }));

        db.close();

        return {
            storage_type: `indexedDB/${dbName}/${storeName}`,
            items: formattedItems,
            total_items: totalItems,
            total_size_bytes: totalSizeBytes,
            paginated: totalItems > pageSize,
            page,
            page_size: pageSize
        };
    } catch (error) {
        throw new Error(`Failed to query IndexedDB ${dbName}/${storeName}: ${error}`);
    }
}
