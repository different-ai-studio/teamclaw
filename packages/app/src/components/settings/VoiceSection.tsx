import * as React from "react";
import { useTranslation } from "react-i18next";
import { Mic, Download, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingCard, SectionHeader, ToggleSwitch } from "./shared";
import { cn, isTauri } from "@/lib/utils";
import { useVoiceInputStore } from "@/stores/voice-input";

interface DownloadableModel {
  id: string;
  name: string;
  file: string;
  size: string;
  installed: boolean;
}

export function VoiceSection() {
  const { t } = useTranslation();
  const voiceEnabled = useVoiceInputStore((s) => s.voiceEnabled);
  const setVoiceEnabled = useVoiceInputStore((s) => s.setVoiceEnabled);
  const [models, setModels] = React.useState<DownloadableModel[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadModels = React.useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<DownloadableModel[]>("stt_list_downloadable_models");
      setModels(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load models");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadModels();
  }, [loadModels]);

  const handleDownload = React.useCallback(
    async (id: string) => {
      if (!isTauri()) return;
      setDownloadingId(id);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("stt_download_model", { modelId: id });
        await loadModels();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Download failed");
      } finally {
        setDownloadingId(null);
      }
    },
    [loadModels],
  );

  if (!isTauri()) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Mic}
          title={t("settings.voice.title", "Offline Voice Input")}
          description={t(
            "settings.voice.webHint",
            "Voice model settings are only available in the desktop app.",
          )}
          iconColor="text-pink-500"
        />
        <SettingCard>
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium">{t("settings.voice.enableVoice", "Enable Voice Input")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("settings.voice.enableVoiceDesc", "Show the voice input button and allow voice shortcuts.")}
              </p>
            </div>
            <ToggleSwitch enabled={voiceEnabled} onChange={setVoiceEnabled} />
          </div>
        </SettingCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Mic}
        title={t("settings.voice.title", "Offline Voice Input")}
        description={t(
          "settings.voice.description",
          "Download a Whisper model for offline speech-to-text. Smaller models are faster and use less disk space; larger models give better accuracy.",
        )}
        iconColor="text-pink-500"
      />

      <SettingCard>
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-medium">{t("settings.voice.enableVoice", "Enable Voice Input")}</h4>
            <p className="text-sm text-muted-foreground">
              {t("settings.voice.enableVoiceDesc", "Show the voice input button and allow voice shortcuts.")}
            </p>
          </div>
          <ToggleSwitch enabled={voiceEnabled} onChange={setVoiceEnabled} />
        </div>
      </SettingCard>

      <SettingCard>
        <h4 className="font-medium mb-3">
          {t("settings.voice.models", "Speech recognition models")}
        </h4>
        {error && (
          <p className="text-sm text-destructive mb-3" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t("settings.voice.loading", "Loading...")}</span>
          </div>
        ) : (
          <ul className="space-y-2">
            {models.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "flex items-center justify-between gap-4 rounded-lg border p-3",
                  "bg-muted/30 border-border",
                )}
              >
                <div>
                  <span className="font-medium">{m.name}</span>
                  <span className="text-muted-foreground text-sm ml-2">
                    {m.size}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {m.installed ? (
                    <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("settings.voice.installed", "Installed")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={downloadingId !== null}
                      onClick={() => handleDownload(m.id)}
                    >
                      {downloadingId === m.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5 mr-1" />
                      )}
                      {t("settings.voice.download", "Download")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingCard>
    </div>
  );
}
