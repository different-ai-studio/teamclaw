import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getBackend } from '@/lib/backend'
import { formatActorRemoveError } from '@/lib/actor-remove-error'
import { useActorsForTeam, type ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import { LocalDaemonRow } from '@/components/sidebar/LocalDaemonRow'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { getKnownLocalDaemonActorId, noteLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { useLocalDaemonRuntimeStatus } from '@/hooks/use-local-daemon-http-status'
import { useMqttConnected } from '@/hooks/useMqttConnected'
import { cn } from '@/lib/utils'
import { ActorDetailDialog } from '@/components/sidebar/ActorDetailDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useUIStore } from '@/stores/ui'

/**
 * The local daemon agent, pinned to the BOTTOM of the sidebar (just above the
 * Settings footer) inside a small bordered card. Previously this row lived at
 * the top of Recents; giving it a deliberate home of its own keeps its
 * coral-emphasized styling from looking out of place among the recent contacts.
 *
 * Self-contained: it resolves the local daemon actor itself and owns the
 * detail / remove dialogs and copy handlers (ActorsSection no longer renders
 * the daemon row, it only filters the daemon out of the Recents list).
 */
export function LocalDaemonCard() {
  const { t } = useTranslation()
  const { actors, refetch, teamId } = useActorsForTeam()
  const defaultAgentId = useMemberPreferencesStore((s) => s.defaultAgentId)

  const [detailFor, setDetailFor] = React.useState<ActorRowData | null>(null)
  const [removeFor, setRemoveFor] = React.useState<ActorRowData | null>(null)
  const [removing, setRemoving] = React.useState(false)

  const [localDaemonAgentId, setLocalDaemonAgentId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!teamId) {
      setLocalDaemonAgentId(null)
      return
    }

    const knownId = getKnownLocalDaemonActorId()
    if (knownId && actors.some((a) => a.id === knownId)) {
      setLocalDaemonAgentId((prev) => prev ?? knownId)
    }

    let cancelled = false
    void getLocalDaemonAgent(teamId).then((a) => {
      if (cancelled || !a?.id) return
      setLocalDaemonAgentId(a.id)
      noteLocalDaemonActorId(a.id)
    })
    return () => { cancelled = true }
  }, [teamId, actors])

  const localDaemonActor = React.useMemo(
    () => actors.find((a) => a.id === localDaemonAgentId) ?? null,
    [actors, localDaemonAgentId],
  )
  const runtimeStatus = useLocalDaemonRuntimeStatus(
    localDaemonActor?.id ?? null,
    !!localDaemonActor,
  )
  const mqttConnected = useMqttConnected()
  const mqttDisconnected = runtimeStatus === 'mqttDisconnected'
  const setMqttNoticeSuppressed = useUIStore((s) => s.setLocalDaemonMqttNoticeSuppressed)

  React.useEffect(() => {
    const suppress = !!localDaemonActor && mqttConnected === false
    setMqttNoticeSuppressed(suppress)
    return () => setMqttNoticeSuppressed(false)
  }, [localDaemonActor, mqttConnected, setMqttNoticeSuppressed])

  const handleCopyName = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
      toast.success(t('actors.copiedName', 'Copied name'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.id)
      toast.success(t('actors.copiedId', 'Copied actor ID'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const confirmRemove = async () => {
    if (!removeFor || !teamId) return
    setRemoving(true)
    try {
      await getBackend().teams.removeTeamActor(teamId, removeFor.id)
      toast.success(t('actors.removed', 'Removed from team'))
      setRemoveFor(null)
      refetch()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(formatActorRemoveError(msg, t))
    } finally {
      setRemoving(false)
    }
  }

  if (!localDaemonActor) return null

  return (
    <>
      <ActorDetailDialog
        actor={detailFor}
        teamId={teamId}
        onOpenChange={(open) => { if (!open) setDetailFor(null) }}
        onRemoved={refetch}
      />
      <AlertDialog open={!!removeFor} onOpenChange={(open) => { if (!open) setRemoveFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('actors.removeConfirm.titleAgent', 'Remove agent?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('actors.removeConfirm.body', 'Remove {{name}} from the team. This cannot be undone.', { name: removeFor?.display_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove} disabled={removing}>
              {t('actors.removeConfirm.cta', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div
        className={cn(
          'group/local-daemon flex max-h-[45vh] flex-col overflow-y-auto rounded-lg border bg-paper p-1 shadow-sm transition-[max-height,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          mqttDisconnected ? 'border-[color:var(--coral-soft)]' : 'border-border-soft',
        )}
      >
        <LocalDaemonRow
          actor={localDaemonActor}
          runtimeStatus={runtimeStatus}
          isDefault={localDaemonActor.id === defaultAgentId}
          onViewDetail={setDetailFor}
          onCopyName={handleCopyName}
          onCopyId={handleCopyId}
          onRequestRemove={setRemoveFor}
        />
      </div>
    </>
  )
}
