import { c as createRoot, j as jsxRuntimeExports, r as reactExports, T as TabItem, B as Button, A as AuthTokenSection } from "./authToken.js";
const StatusApp = () => {
  const [status, setStatus] = reactExports.useState({
    isConnected: false,
    connectedTabId: null
  });
  reactExports.useEffect(() => {
    void loadStatus();
  }, []);
  const loadStatus = async () => {
    const { connectedTabId } = await chrome.runtime.sendMessage({ type: "getConnectionStatus" });
    if (connectedTabId) {
      const tab = await chrome.tabs.get(connectedTabId);
      setStatus({
        isConnected: true,
        connectedTabId,
        connectedTab: {
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl
        }
      });
    } else {
      setStatus({
        isConnected: false,
        connectedTabId: null
      });
    }
  };
  const openConnectedTab = async () => {
    if (!status.connectedTabId)
      return;
    await chrome.tabs.update(status.connectedTabId, { active: true });
    window.close();
  };
  const disconnect = async () => {
    await chrome.runtime.sendMessage({ type: "disconnect" });
    window.close();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "app-container", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-wrapper", children: [
    status.isConnected && status.connectedTab ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tab-section-title", children: "Page with connected MCP client:" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        TabItem,
        {
          tab: status.connectedTab,
          button: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: disconnect, children: "Disconnect" }),
          onClick: openConnectedTab
        }
      ) })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "status-banner", children: "No MCP clients are currently connected." }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(AuthTokenSection, {})
  ] }) });
};
const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(StatusApp, {}));
}
