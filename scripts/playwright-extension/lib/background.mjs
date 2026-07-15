var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
function debugLog(...args) {
  {
    console.log("[Extension]", ...args);
  }
}
class RelayConnection {
  constructor(ws) {
    __publicField(this, "_debuggee");
    __publicField(this, "_ws");
    __publicField(this, "_eventListener");
    __publicField(this, "_detachListener");
    __publicField(this, "_tabPromise");
    __publicField(this, "_tabPromiseResolve");
    __publicField(this, "_closed", false);
    __publicField(this, "onclose");
    this._debuggee = {};
    this._tabPromise = new Promise((resolve) => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);
  }
  // Either setTabId or close is called after creating the connection.
  setTabId(tabId) {
    this._debuggee = { tabId };
    this._tabPromiseResolve();
  }
  close(message) {
    this._ws.close(1e3, message);
    this._onClose();
  }
  _onClose() {
    var _a;
    if (this._closed)
      return;
    this._closed = true;
    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {
    });
    (_a = this.onclose) == null ? void 0 : _a.call(this);
  }
  _onDebuggerEvent(source, method, params) {
    if (source.tabId !== this._debuggee.tabId)
      return;
    debugLog("Forwarding CDP event:", method, params);
    const sessionId = source.sessionId;
    this._sendMessage({
      method: "forwardCDPEvent",
      params: {
        sessionId,
        method,
        params
      }
    });
  }
  _onDebuggerDetach(source, reason) {
    if (source.tabId !== this._debuggee.tabId)
      return;
    this.close(`Debugger detached: ${reason}`);
    this._debuggee = {};
  }
  _onMessage(event) {
    this._onMessageAsync(event).catch((e) => debugLog("Error handling message:", e));
  }
  async _onMessageAsync(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      debugLog("Error parsing message:", error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }
    debugLog("Received message:", message);
    const response = {
      id: message.id
    };
    try {
      response.result = await this._handleCommand(message);
    } catch (error) {
      debugLog("Error handling command:", error);
      response.error = error.message;
    }
    debugLog("Sending response:", response);
    this._sendMessage(response);
  }
  async _handleCommand(message) {
    if (message.method === "attachToTab") {
      await this._tabPromise;
      debugLog("Attaching debugger to tab:", this._debuggee);
      await chrome.debugger.attach(this._debuggee, "1.3");
      const result = await chrome.debugger.sendCommand(this._debuggee, "Target.getTargetInfo");
      return {
        targetInfo: result == null ? void 0 : result.targetInfo
      };
    }
    if (!this._debuggee.tabId)
      throw new Error("No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.");
    if (message.method === "forwardCDPCommand") {
      const { sessionId, method, params } = message.params;
      debugLog("CDP command:", method, params);
      const debuggerSession = {
        ...this._debuggee,
        sessionId
      };
      return await chrome.debugger.sendCommand(
        debuggerSession,
        method,
        params
      );
    }
  }
  _sendError(code, message) {
    this._sendMessage({
      error: {
        code,
        message
      }
    });
  }
  _sendMessage(message) {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
class TabShareExtension {
  constructor() {
    __publicField(this, "_activeConnection");
    __publicField(this, "_connectedTabId", null);
    __publicField(this, "_pendingTabSelection", /* @__PURE__ */ new Map());
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
  }
  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  _onMessage(message, sender, sendResponse) {
    var _a, _b;
    switch (message.type) {
      case "connectToMCPRelay":
        this._connectToRelay(sender.tab.id, message.mcpRelayUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "getTabs":
        this._getTabs().then(
          (tabs) => {
            var _a2;
            return sendResponse({ success: true, tabs, currentTabId: (_a2 = sender.tab) == null ? void 0 : _a2.id });
          },
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "connectToTab":
        const tabId = message.tabId || ((_a = sender.tab) == null ? void 0 : _a.id);
        const windowId = message.windowId || ((_b = sender.tab) == null ? void 0 : _b.windowId);
        this._connectTab(sender.tab.id, tabId, windowId, message.mcpRelayUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "getConnectionStatus":
        sendResponse({
          connectedTabId: this._connectedTabId
        });
        return false;
      case "disconnect":
        this._disconnect().then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
    }
    return false;
  }
  async _connectToRelay(selectorTabId, mcpRelayUrl) {
    try {
      debugLog(`Connecting to relay at ${mcpRelayUrl}`);
      const socket = new WebSocket(mcpRelayUrl);
      await new Promise((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("WebSocket error"));
        setTimeout(() => reject(new Error("Connection timeout")), 5e3);
      });
      const connection = new RelayConnection(socket);
      connection.onclose = () => {
        debugLog("Connection closed");
        this._pendingTabSelection.delete(selectorTabId);
      };
      this._pendingTabSelection.set(selectorTabId, { connection });
      debugLog(`Connected to MCP relay`);
    } catch (error) {
      const message = `Failed to connect to MCP relay: ${error.message}`;
      debugLog(message);
      throw new Error(message);
    }
  }
  async _connectTab(selectorTabId, tabId, windowId, mcpRelayUrl) {
    var _a, _b;
    try {
      debugLog(`Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);
      try {
        (_a = this._activeConnection) == null ? void 0 : _a.close("Another connection is requested");
      } catch (error) {
        debugLog(`Error closing active connection:`, error);
      }
      await this._setConnectedTabId(null);
      this._activeConnection = (_b = this._pendingTabSelection.get(selectorTabId)) == null ? void 0 : _b.connection;
      if (!this._activeConnection)
        throw new Error("No active MCP relay connection");
      this._pendingTabSelection.delete(selectorTabId);
      this._activeConnection.setTabId(tabId);
      this._activeConnection.onclose = () => {
        debugLog("MCP connection closed");
        this._activeConnection = void 0;
        void this._setConnectedTabId(null);
      };
      await Promise.all([
        this._setConnectedTabId(tabId),
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(windowId, { focused: true })
      ]);
      debugLog(`Connected to MCP bridge`);
    } catch (error) {
      await this._setConnectedTabId(null);
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      throw error;
    }
  }
  async _setConnectedTabId(tabId) {
    const oldTabId = this._connectedTabId;
    this._connectedTabId = tabId;
    if (oldTabId && oldTabId !== tabId)
      await this._updateBadge(oldTabId, { text: "" });
    if (tabId)
      await this._updateBadge(tabId, { text: "✓", color: "#4CAF50", title: "Connected to MCP client" });
  }
  async _updateBadge(tabId, { text, color, title }) {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || "" });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (error) {
    }
  }
  async _onTabRemoved(tabId) {
    var _a, _b;
    const pendingConnection = (_a = this._pendingTabSelection.get(tabId)) == null ? void 0 : _a.connection;
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.close("Browser tab closed");
      return;
    }
    if (this._connectedTabId !== tabId)
      return;
    (_b = this._activeConnection) == null ? void 0 : _b.close("Browser tab closed");
    this._activeConnection = void 0;
    this._connectedTabId = null;
  }
  _onTabActivated(activeInfo) {
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = void 0;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close("Tab has been inactive for 5 seconds");
            chrome.tabs.sendMessage(tabId, { type: "connectionTimeout" });
          }
        }, 5e3);
        return;
      }
    }
  }
  _onTabUpdated(tabId, changeInfo, tab) {
    if (this._connectedTabId === tabId)
      void this._setConnectedTabId(tabId);
  }
  async _getTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.url && !["chrome:", "edge:", "devtools:"].some((scheme) => tab.url.startsWith(scheme)));
  }
  async _onActionClicked() {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("status.html"),
      active: true
    });
  }
  async _disconnect() {
    var _a;
    (_a = this._activeConnection) == null ? void 0 : _a.close("User disconnected");
    this._activeConnection = void 0;
    await this._setConnectedTabId(null);
  }
}
new TabShareExtension();
