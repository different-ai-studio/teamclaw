import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { buildConfig } from "@/lib/build-config";
import { useAppVersion } from "@/lib/version";

/**
 * Branded first-run welcome. Rendered at the top of the app shell — before the
 * dependency setup guide — so it is the very first screen a new user sees.
 * Dismissing it (Get started) is what unblocks dependency initialization.
 */
export function WelcomeScreen({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  const appVersion = useAppVersion();

  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground">
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <img
            src="/logo.png"
            alt={`${buildConfig.app.name} logo`}
            className="mb-5 h-20 w-20 object-contain"
          />
          <h1 className="text-[30px] font-semibold text-foreground">{buildConfig.app.name}</h1>
          <p className="mt-3 max-w-sm text-[14px] leading-6 text-ink-2">
            {t("auth.onboarding.tagline", "Choose how to enter TeamClaw.")}
          </p>
          <Button className="mt-8 bg-coral text-paper hover:bg-coral/90" onClick={onContinue}>
            {t("auth.onboarding.getStarted", "Get started")}
          </Button>
        </div>
        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
      </div>
    </div>
  );
}
