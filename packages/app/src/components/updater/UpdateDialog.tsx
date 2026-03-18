import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Download, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react"

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
  const { update, checkForUpdates, installUpdate, restart } = useUpdaterStore()
  const [dismissed, setDismissed] = useState(false)

  // Check for updates on app startup (3s delay)
  useEffect(() => {
    if (typeof window === "undefined" || !(window as unknown as { __TAURI__: unknown }).__TAURI__) {
      return
    }

    const timer = setTimeout(() => {
      checkForUpdates(true)
    }, 3000)

    return () => clearTimeout(timer)
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

  const showDialog = !dismissed && (
    update.state === "available" ||
    update.state === "downloading" ||
    update.state === "ready" ||
    update.state === "error"
  )

  return (
    <Dialog open={showDialog} onOpenChange={() => handleDismiss()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-muted text-primary">
              {update.state === "error" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : update.state === "ready" ? (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              ) : (
                <Download className="h-5 w-5" />
              )}
            </div>
            <DialogTitle className="text-lg">
              {update.state === "available" && t('updater.available', 'Update Available')}
              {update.state === "downloading" && t('updater.downloading', 'Downloading Update...')}
              {update.state === "ready" && t('updater.ready', 'Update Ready')}
              {update.state === "error" && t('updater.failed', 'Update Failed')}
            </DialogTitle>
          </div>
          <DialogDescription className="text-left">
            {update.state === "available" && (
              <>{t('updater.newVersion', 'A new version')} <span className="font-medium text-foreground">v{update.version}</span> {t('updater.isAvailable', 'is available.')}</>
            )}
            {update.state === "downloading" && t('updater.pleaseWait', 'Please wait while the update is being downloaded.')}
            {update.state === "ready" && t('updater.restartToApply', 'The update has been installed. Restart to apply changes.')}
            {update.state === "error" && t('updater.updateError', 'An error occurred during the update process.')}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* Release notes */}
          {update.state === "available" && update.notes && (
            <div className="rounded-lg border bg-muted/50 p-3 max-h-48 overflow-auto">
              <p className="text-xs font-medium text-muted-foreground mb-1">{t('updater.releaseNotes', 'Release Notes')}</p>
              <p className="text-sm whitespace-pre-wrap">{update.notes}</p>
            </div>
          )}

          {/* Download progress */}
          {update.state === "downloading" && (
            <div className="space-y-2">
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${update.progress ?? 0}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center">{update.progress ?? 0}%</p>
            </div>
          )}

          {/* Error message */}
          {update.state === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{update.errorMessage}</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {update.state === "available" && (
            <>
              <Button variant="outline" onClick={handleDismiss} className="w-full sm:w-auto">
                {t('updater.later', 'Later')}
              </Button>
              <Button onClick={installUpdate} className="w-full sm:w-auto">
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('updater.updateNow', 'Update Now')}
              </Button>
            </>
          )}

          {update.state === "downloading" && (
            <Button disabled className="w-full sm:w-auto">
              <Download className="h-4 w-4 mr-2 animate-bounce" />
              {t('updater.downloading', 'Downloading Update...')}
            </Button>
          )}

          {update.state === "ready" && (
            <Button onClick={restart} className="w-full sm:w-auto">
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('updater.restartNow', 'Restart Now')}
            </Button>
          )}

          {update.state === "error" && (
            <Button variant="outline" onClick={handleDismiss} className="w-full sm:w-auto">
              {t('common.close', 'Close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
