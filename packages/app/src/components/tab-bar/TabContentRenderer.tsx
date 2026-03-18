import { useTabsStore, selectActiveTab } from "@/stores/tabs";
import { WebViewContent } from "@/components/main-content/WebViewContent";
import { NativeContent } from "@/components/main-content/NativeContent";

export function TabContentRenderer() {
  const activeTab = useTabsStore(selectActiveTab);

  if (!activeTab) return null;

  if (activeTab.type === "webview") {
    return (
      <div className="h-full pointer-events-none">
        <WebViewContent url={activeTab.target} />
      </div>
    );
  }

  if (activeTab.type === "native") {
    return (
      <div className="h-full">
        <NativeContent target={activeTab.target} />
      </div>
    );
  }

  // File tab — renders a placeholder that App.tsx will fill with existing file viewers
  return (
    <div className="h-full" data-testid="file-content" data-file-target={activeTab.target} />
  );
}
