import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Info,
  ChevronRight,
  Download,
  Loader2,
  ExternalLink,
  Github,
  FileText,
  Heart,
  Shield,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { buildConfig } from "@/lib/build-config";
import { useUpdaterStore } from "@/stores/updater";
import { useAppVersion } from "@/lib/version";
import { Button } from "@/components/ui/button";
import { SettingCard, SectionHeader } from "./shared";
import { openExternalUrl } from "@/lib/utils";

export const AboutSection = React.memo(function AboutSection() {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const update = useUpdaterStore((s) => s.update);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const installUpdate = useUpdaterStore((s) => s.installUpdate);
  const isChecking = update.state === "checking";
  const isAvailable = update.state === "available";
  const isUpToDate = update.state === "up-to-date";
  const isDownloading = update.state === "downloading";
  const isReady = update.state === "ready";
  const isError = update.state === "error";

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Info}
        title={t("settings.about.title", "About")}
        description={t(
          "settings.about.description",
          "AI Agent Desktop Platform",
        )}
        iconColor="text-cyan-500"
      />

      <SettingCard className="bg-gradient-to-br from-primary/5 to-primary/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img
              src="/logo-64.png"
              alt={`${buildConfig.app.name} Logo`}
              className="h-14 w-14 object-contain"
            />
            <div>
              <h4 className="font-semibold text-lg">{buildConfig.app.name}</h4>
              <p className="text-sm text-muted-foreground">
                Version {appVersion}
              </p>
            </div>
          </div>
          <Button
            variant={isAvailable ? "default" : "outline"}
            onClick={isAvailable ? installUpdate : () => checkForUpdates()}
            disabled={isChecking || isDownloading || isReady}
            className="gap-2"
          >
            {isChecking ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("settings.about.checking", "Checking...")}
              </>
            ) : isDownloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("settings.update.updating", "Updating…")}
                {update.progress != null && update.progress > 0 ? ` ${update.progress}%` : ""}
              </>
            ) : isAvailable ? (
              <>
                <Download className="h-4 w-4" />
                Update to v{update.version}
              </>
            ) : isUpToDate ? (
              <>
                <RefreshCw className="h-4 w-4" />
                {t("settings.about.upToDate", "Up to date")}
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                {t("settings.about.checkUpdates", "Check Updates")}
              </>
            )}
          </Button>
        </div>
      </SettingCard>

      {isAvailable && (
        <SettingCard className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800">
          <div className="flex items-start gap-3">
            <Download className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p className="font-medium text-blue-900 dark:text-blue-100">
                {t("settings.about.newVersion", "New version available:")} v
                {update.version}
              </p>
              {update.notes && (
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  {update.notes}
                </p>
              )}
              <Button size="sm" className="mt-2 gap-2" onClick={installUpdate}>
                <Download className="h-3 w-3" />
                {t("settings.about.downloadInstall", "Download & Install")}
              </Button>
            </div>
          </div>
        </SettingCard>
      )}

      {isReady && (
        <SettingCard className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 border-green-200 dark:border-green-800">
          <div className="flex items-start gap-3">
            <RefreshCw className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p className="font-medium text-green-900 dark:text-green-100">
                {t(
                  "settings.about.updateInstalled",
                  "Update installed successfully",
                )}
              </p>
              <p className="text-sm text-green-700 dark:text-green-300">
                {t(
                  "settings.about.restartToApply",
                  "Restart the app to apply changes.",
                )}
              </p>
              <Button
                size="sm"
                className="mt-2 gap-2"
                onClick={() => useUpdaterStore.getState().restart()}
              >
                <RefreshCw className="h-3 w-3" />
                {t("settings.about.restartNow", "Restart Now")}
              </Button>
            </div>
          </div>
        </SettingCard>
      )}

      {isError && (
        <SettingCard className="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p className="font-medium text-red-900 dark:text-red-100">
                {t("settings.about.updateFailed", "Update check failed")}
              </p>
              <p className="text-sm text-red-700 dark:text-red-300">
                {update.errorMessage}
              </p>
            </div>
          </div>
        </SettingCard>
      )}

      <SettingCard>
        <h4 className="font-medium mb-4">
          {t("settings.about.quickLinks", "Quick Links")}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          {[
            {
              icon: FileText,
              label: t("settings.about.documentation", "Documentation"),
              href: "#",
            },
            {
              icon: Github,
              label: "GitHub",
              href: "https://github.com/different-ai-studio/teamclaw",
            },
            {
              icon: ExternalLink,
              label: t("settings.about.reportIssue", "Report Issue"),
              href: "https://github.com/different-ai-studio/teamclaw/issues",
            },
            {
              icon: Shield,
              label: t("settings.about.license", "License"),
              href: "#",
            },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              onClick={(e) => {
                e.preventDefault();
                if (link.href !== "#") openExternalUrl(link.href);
              }}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors group cursor-pointer"
            >
              <link.icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                {link.label}
              </span>
              <ChevronRight className="h-3 w-3 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </a>
          ))}
        </div>
      </SettingCard>

      <div className="text-center py-6">
        <p className="text-sm text-muted-foreground flex items-center justify-center gap-1">
          {t("settings.about.madeWith", "Made with")}{" "}
          <Heart className="h-4 w-4 text-red-500 fill-red-500" />{" "}
          {t("settings.about.byTeam", { defaultValue: "by {{appName}} Team", appName: buildConfig.app.name })}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          &copy; 2024 {buildConfig.app.name}. All rights reserved.
        </p>
      </div>
    </div>
  );
});
