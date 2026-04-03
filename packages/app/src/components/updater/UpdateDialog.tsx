import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useUpdaterStore } from "@/stores/updater"

export function UpdateDialogContainer() {
  const { t } = useTranslation()
  const { update, checkForUpdates, retryUpdate, restart } = useUpdaterStore()
  const [dismissed, setDismissed] = useState(false)

  // Check for updates on app startup (3s delay) and every 4 hours
  useEffect(() => {
    if (typeof window === "undefined" || !(window as unknown as { __TAURI__: unknown }).__TAURI__) {
      return
    }

    const timer = setTimeout(() => {
      checkForUpdates(true)
    }, 3000)

    const interval = setInterval(() => {
      checkForUpdates(true)
    }, 4 * 60 * 60 * 1000)

    return () => {
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, [checkForUpdates])

  // Reset dismissed state when a new check starts
  useEffect(() => {
    if (update.state === "checking") {
      setDismissed(false)
    }
  }, [update.state])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  // Updates download/install in the background; only prompt the user to restart (or report failure).
  const showDialog =
    !dismissed && (update.state === "ready" || update.state === "error")

  return (
    <Dialog open={showDialog} onOpenChange={() => handleDismiss()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-muted text-primary">
              {update.state === "error" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              )}
            </div>
            <DialogTitle className="text-lg">
              {update.state === "ready" && t('updater.ready', 'Update Ready')}
              {update.state === "error" && t('updater.failed', 'Update Failed')}
            </DialogTitle>
          </div>
          <DialogDescription asChild>
            {update.state === "ready" ? (
              <div className="text-left space-y-2 text-sm text-muted-foreground">
                <p>
                  {update.version && (
                    <span className="font-medium text-foreground">v{update.version}</span>
                  )}
                  {update.version && " — "}
                  {t('updater.restartToApply', 'The update has been installed. Restart to apply changes.')}
                </p>
                <p>
                  {t(
                    'updater.restartRecommendation',
                    'The update is installed. We recommend restarting soon to use the new version.',
                  )}
                </p>
              </div>
            ) : (
              <p className="text-left text-sm text-muted-foreground">
                {t('updater.updateError', 'An error occurred during the update process.')}
              </p>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {update.state === "ready" && update.notes && (
            <div className="rounded-lg border bg-muted/50 p-3 max-h-48 overflow-auto">
              <p className="text-xs font-medium text-muted-foreground mb-1">{t('updater.releaseNotes', 'Release Notes')}</p>
              <p className="text-sm whitespace-pre-wrap">{update.notes}</p>
            </div>
          )}

          {update.state === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{update.errorMessage}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {update.state === "ready" && (
            <>
              <Button variant="outline" onClick={handleDismiss} className="w-full sm:w-auto">
                {t('updater.restartLater', 'Restart later')}
              </Button>
              <Button onClick={restart} className="w-full sm:w-auto">
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('updater.restartNow', 'Restart Now')}
              </Button>
            </>
          )}

          {update.state === "error" && (
            <>
              <Button variant="outline" onClick={handleDismiss} className="w-full sm:w-auto">
                {t('common.close', 'Close')}
              </Button>
              <Button onClick={retryUpdate} className="w-full sm:w-auto">
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('updater.retry', 'Retry')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
