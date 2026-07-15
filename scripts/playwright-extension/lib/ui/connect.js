import { c as createRoot, j as jsxRuntimeExports, r as reactExports, B as Button, A as AuthTokenSection, T as TabItem, g as getOrCreateAuthToken } from "./authToken.js";
const SUPPORTED_PROTOCOL_VERSION = 1;
const ConnectApp = () => {
  const [tabs, setTabs] = reactExports.useState([]);
  const [status, setStatus] = reactExports.useState(null);
  const [showButtons, setShowButtons] = reactExports.useState(true);
  const [showTabList, setShowTabList] = reactExports.useState(true);
  const [clientInfo, setClientInfo] = reactExports.useState("unknown");
  const [mcpRelayUrl, setMcpRelayUrl] = reactExports.useState("");
  const [newTab, setNewTab] = reactExports.useState(false);
  reactExports.useEffect(() => {
    const runAsync = async () => {
      const params = new URLSearchParams(window.location.search);
      const relayUrl = params.get("mcpRelayUrl");
      if (!relayUrl) {
        handleReject("Missing mcpRelayUrl parameter in URL.");
        return;
      }
      try {
        const host = new URL(relayUrl).hostname;
        if (host !== "127.0.0.1" && host !== "[::1]") {
          handleReject(`MCP extension only allows loopback connections (127.0.0.1 or [::1]). Received host: ${host}`);
          return;
        }
      } catch (e) {
        handleReject(`Invalid mcpRelayUrl parameter in URL: ${relayUrl}. ${e}`);
        return;
      }
      setMcpRelayUrl(relayUrl);
      try {
        const client = JSON.parse(params.get("client") || "{}");
        const info = `${client.name}/${client.version}`;
        setClientInfo(info);
        setStatus({
          type: "connecting",
          message: `🎭 Playwright MCP started from  "${info}" is trying to connect. Do you want to continue?`
        });
      } catch (e) {
        setStatus({ type: "error", message: "Failed to parse client version." });
        return;
      }
      const parsedVersion = parseInt(params.get("protocolVersion") ?? "", 10);
      const requiredVersion = isNaN(parsedVersion) ? 1 : parsedVersion;
      if (requiredVersion > SUPPORTED_PROTOCOL_VERSION) {
        const extensionVersion = chrome.runtime.getManifest().version;
        setShowButtons(false);
        setShowTabList(false);
        setStatus({
          type: "error",
          versionMismatch: {
            extensionVersion
          }
        });
        return;
      }
      const expectedToken = getOrCreateAuthToken();
      const token = params.get("token");
      if (token === expectedToken) {
        await connectToMCPRelay(relayUrl);
        await handleConnectToTab();
        return;
      }
      if (token) {
        handleReject("Invalid token provided.");
        return;
      }
      await connectToMCPRelay(relayUrl);
      if (params.get("newTab") === "true") {
        setNewTab(true);
        setShowTabList(false);
      } else {
        await loadTabs();
      }
    };
    void runAsync();
  }, []);
  const handleReject = reactExports.useCallback((message) => {
    setShowButtons(false);
    setShowTabList(false);
    setStatus({ type: "error", message });
  }, []);
  const connectToMCPRelay = reactExports.useCallback(async (mcpRelayUrl2) => {
    const response = await chrome.runtime.sendMessage({ type: "connectToMCPRelay", mcpRelayUrl: mcpRelayUrl2 });
    if (!response.success)
      handleReject(response.error);
  }, [handleReject]);
  const loadTabs = reactExports.useCallback(async () => {
    const response = await chrome.runtime.sendMessage({ type: "getTabs" });
    if (response.success)
      setTabs(response.tabs);
    else
      setStatus({ type: "error", message: "Failed to load tabs: " + response.error });
  }, []);
  const handleConnectToTab = reactExports.useCallback(async (tab) => {
    setShowButtons(false);
    setShowTabList(false);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "connectToTab",
        mcpRelayUrl,
        tabId: tab == null ? void 0 : tab.id,
        windowId: tab == null ? void 0 : tab.windowId
      });
      if (response == null ? void 0 : response.success) {
        setStatus({ type: "connected", message: `MCP client "${clientInfo}" connected.` });
      } else {
        setStatus({
          type: "error",
          message: (response == null ? void 0 : response.error) || `MCP client "${clientInfo}" failed to connect.`
        });
      }
    } catch (e) {
      setStatus({
        type: "error",
        message: `MCP client "${clientInfo}" failed to connect: ${e}`
      });
    }
  }, [clientInfo, mcpRelayUrl]);
  reactExports.useEffect(() => {
    const listener = (message) => {
      if (message.type === "connectionTimeout")
        handleReject("Connection timed out.");
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [handleReject]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "app-container", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-wrapper", children: [
    status && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "status-container", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(StatusBanner, { status }),
      showButtons && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "button-container", children: newTab ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: () => handleConnectToTab(), children: "Allow" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "reject", onClick: () => handleReject("Connection rejected. This tab can be closed."), children: "Reject" })
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "reject", onClick: () => handleReject("Connection rejected. This tab can be closed."), children: "Reject" }) })
    ] }),
    (status == null ? void 0 : status.type) === "connecting" && /* @__PURE__ */ jsxRuntimeExports.jsx(AuthTokenSection, {}),
    showTabList && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tab-section-title", children: "Select page to expose to MCP server:" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: tabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        TabItem,
        {
          tab,
          button: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: () => handleConnectToTab(tab), children: "Connect" })
        },
        tab.id
      )) })
    ] })
  ] }) });
};
const VersionMismatchError = ({ extensionVersion }) => {
  const readmeUrl = "https://github.com/microsoft/playwright-mcp/blob/main/extension/README.md";
  const latestReleaseUrl = "https://github.com/microsoft/playwright-mcp/releases/latest";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
    "Playwright MCP version trying to connect requires newer extension version (current version: ",
    extensionVersion,
    ").",
    " ",
    /* @__PURE__ */ jsxRuntimeExports.jsx("a", { href: latestReleaseUrl, children: "Click here" }),
    " to download latest version of the extension, then drag and drop it into the Chrome Extensions page.",
    " ",
    "See ",
    /* @__PURE__ */ jsxRuntimeExports.jsx("a", { href: readmeUrl, target: "_blank", rel: "noopener noreferrer", children: "installation instructions" }),
    " for more details."
  ] });
};
const StatusBanner = ({ status }) => {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: `status-banner ${status.type}`, children: "versionMismatch" in status ? /* @__PURE__ */ jsxRuntimeExports.jsx(
    VersionMismatchError,
    {
      extensionVersion: status.versionMismatch.extensionVersion
    }
  ) : status.message });
};
const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(ConnectApp, {}));
}
