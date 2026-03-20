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
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState<{
    bytesDownloaded: number;
    totalBytes: number | null;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Throttle high-frequency progress events to avoid React re-render jank.
  const progressBufferRef = React.useRef<{
    bytesDownloaded: number;
    totalBytes: number | null;
  } | null>(null);
  const progressFlushTimerRef = React.useRef<number | null>(null);

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

  React.useEffect(() => {
    if (!isTauri() || !downloadingId) return;
    let unlistenProgress: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    progressBufferRef.current = null;
    if (progressFlushTimerRef.current != null) {
      window.clearTimeout(progressFlushTimerRef.current);
      progressFlushTimerRef.current = null;
    }
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenProgress = await listen<{
          modelId: string;
          bytesDownloaded: number;
          totalBytes: number | null;
        }>("stt:download_progress", (event) => {
          if (event.payload.modelId !== downloadingId) return;
          const next = {
            bytesDownloaded: event.payload.bytesDownloaded,
            totalBytes: event.payload.totalBytes ?? null,
          };

          // If we don't have a window (SSR), just update immediately.
          if (typeof window === "undefined") {
            setDownloadProgress(next);
            return;
          }

          progressBufferRef.current = next;
          if (progressFlushTimerRef.current != null) return;
          progressFlushTimerRef.current = window.setTimeout(() => {
            if (progressBufferRef.current) setDownloadProgress(progressBufferRef.current);
            progressBufferRef.current = null;
            progressFlushTimerRef.current = null;
          }, 100);
        });

        unlistenFinished = await listen<{ modelId: string }>("stt:download_finished", (event) => {
          if (event.payload.modelId !== downloadingId) return;
          setDownloadingId(null);
          setDownloadProgress(null);
          setError(null);
          void loadModels();
        });

        unlistenError = await listen<{ modelId: string; message: string }>("stt:download_error", (event) => {
          if (event.payload.modelId !== downloadingId) return;
          setError(event.payload.message ?? "Download failed");
          setDownloadingId(null);
          setDownloadProgress(null);
          progressBufferRef.current = null;
          if (progressFlushTimerRef.current != null) {
            window.clearTimeout(progressFlushTimerRef.current);
            progressFlushTimerRef.current = null;
          }
        });
      } catch {
        setDownloadProgress(null);
      }
    })();
    return () => {
      if (progressFlushTimerRef.current != null) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = null;
      }
      progressBufferRef.current = null;
      unlistenProgress?.();
      unlistenFinished?.();
      unlistenError?.();
    };
  }, [downloadingId, loadModels]);

  const handleDownload = React.useCallback(
    async (id: string) => {
      if (!isTauri()) return;
      setDownloadingId(id);
      setDownloadProgress(null);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("stt_download_model", { modelId: id });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Download failed");
        setDownloadingId(null);
        setDownloadProgress(null);
      } finally {
        // Do not clear downloading state here; it will be cleared by finished/error event.
      }
    },
    [],
  );

  const handleDelete = React.useCallback(
    async (id: string) => {
      if (!isTauri()) return;
      if (downloadingId !== null) return;
      const ok = window.confirm(t("settings.voice.confirmDelete", "Delete this offline voice model?"));
      if (!ok) return;

      setDeletingId(id);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("stt_delete_model", { modelId: id });
        await loadModels();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    },
    [downloadingId, loadModels, t],
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
                <div className="flex min-w-0 flex-1 flex-col items-end gap-2 sm:flex-row sm:flex-initial sm:items-center">
                  {m.installed ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {t("settings.voice.installed", "Installed")}
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={deletingId !== null || downloadingId !== null}
                        onClick={() => handleDelete(m.id)}
                      >
                        {deletingId === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("settings.voice.delete", "Delete")}
                      </Button>
                    </div>
                  ) : downloadingId === m.id ? (
                    <div className="w-full min-w-[120px] max-w-[200px] space-y-1">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{
                            width:
                              downloadProgress?.totalBytes != null && (downloadProgress?.totalBytes ?? 0) > 0
                                ? `${Math.min(100, ((downloadProgress?.bytesDownloaded ?? 0) * 100) / (downloadProgress?.totalBytes ?? 1))}%`
                                : "30%",
                            animation:
                              downloadProgress?.totalBytes == null
                                ? "pulse 1.5s ease-in-out infinite"
                                : undefined,
                          }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground text-right">
                        {downloadProgress?.totalBytes != null && (downloadProgress?.totalBytes ?? 0) > 0
                          ? `${Math.min(100, Math.round(((downloadProgress?.bytesDownloaded ?? 0) * 100) / (downloadProgress?.totalBytes ?? 1)))}%`
                          : downloadProgress
                            ? `${((downloadProgress.bytesDownloaded) / 1024 / 1024).toFixed(1)} MB`
                            : t("settings.voice.downloading", "Downloading...")}
                      </p>
                    </div>
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
