import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { webSsoLayout, repositionWebSso, type WebSsoLayout } from "@/lib/auth/web-sso";

/**
 * Chrome rendered around the native Web SSO webview. The native child webview
 * paints on top of the React layer and fully covers it, so the only way to give
 * the user a visible back/close control is to position it OUTSIDE the webview
 * rect — here, in a header strip reserved just above the panel (see
 * `webSsoLayout`). A backdrop dims the rest of the window; clicking it (or the
 * ✕) cancels the sign-in.
 */
export function WebSsoOverlay({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<WebSsoLayout>(() => webSsoLayout());

  useEffect(() => {
    const onResize = () => {
      setLayout(webSsoLayout());
      void repositionWebSso();
    };
    window.addEventListener("resize", onResize);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop — click to cancel. */}
      <button
        type="button"
        aria-label={t("auth.close", "Close")}
        onClick={onCancel}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
      />
      {/* Header strip aligned above the native webview rect. */}
      <div
        className="absolute flex items-center justify-between rounded-t-[12px] border border-b-0 border-border bg-paper px-3 shadow-xl"
        style={{
          left: layout.frameX,
          top: layout.frameY,
          width: layout.frameW,
          height: layout.headerH,
        }}
      >
        <span className="text-[13px] font-medium text-foreground">
          {t("auth.signInWithWebSso", "Quick sign-in")}
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("auth.close", "Close")}
          className="flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-selected/45 hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
