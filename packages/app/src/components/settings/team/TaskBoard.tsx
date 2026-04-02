/**
 * TaskBoard - shows active and completed tasks with status indicators, urgency badges,
 * bid counts, capability tags, and creator/assignee info.
 */
import * as React from 'react'
import { cn, isTauri } from '@/lib/utils'
import { useSuperAgentStore } from '@/stores/super-agent'
import type { Task, TaskStatus, TaskUrgency, TaskComplexity } from '@/stores/super-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

// ─── Status Dot ──────────────────────────────────────────────────────────────

function statusDotClass(status: TaskStatus): string {
  switch (status) {
    case 'open':
      return 'bg-blue-400'
    case 'bidding':
      return 'bg-yellow-400'
    case 'assigned':
      return 'bg-orange-400'
    case 'running':
      return 'bg-green-500 animate-pulse'
    case 'completed':
      return 'bg-green-500'
    case 'failed':
      return 'bg-red-500'
    case 'aborted':
      return 'bg-muted-foreground/40'
    default:
      return 'bg-muted-foreground/40'
  }
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'open':      return 'Open'
    case 'bidding':   return 'Bidding'
    case 'assigned':  return 'Assigned'
    case 'running':   return 'Running'
    case 'completed': return 'Completed'
    case 'failed':    return 'Failed'
    case 'aborted':   return 'Aborted'
    default:          return status
  }
}

// ─── Urgency Badge ────────────────────────────────────────────────────────────

function urgencyBadgeClass(urgency: TaskUrgency): string {
  switch (urgency) {
    case 'critical':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'high':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    case 'normal':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    case 'low':
      return 'bg-muted text-muted-foreground'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

// ─── Create Task Form ─────────────────────────────────────────────────────────

function CreateTaskForm({ onClose }: { onClose: () => void }) {
  const createTask = useSuperAgentStore((s) => s.createTask)

  const [description, setDescription] = React.useState('')
  const [capabilitiesRaw, setCapabilitiesRaw] = React.useState('')
  const [urgency, setUrgency] = React.useState<TaskUrgency>('normal')
  const [complexity, setComplexity] = React.useState<TaskComplexity>('solo')
  const [submitting, setSubmitting] = React.useState(false)

  const urgencyOptions: TaskUrgency[] = ['low', 'normal', 'high', 'critical']
  const complexityOptions: TaskComplexity[] = ['solo', 'delegate']

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!description.trim()) return
    setSubmitting(true)
    const capabilities = capabilitiesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    await createTask(description.trim(), capabilities, urgency, complexity)
    setSubmitting(false)
    onClose()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border bg-card p-4 space-y-3"
    >
      <p className="text-sm font-medium">New Task</p>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Description</label>
        <Textarea
          placeholder="Describe the task…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="min-h-[72px]"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Capabilities (comma-separated)</label>
        <Input
          placeholder="e.g. coding, testing, analysis"
          value={capabilitiesRaw}
          onChange={(e) => setCapabilitiesRaw(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Urgency</label>
        <div className="flex gap-1.5 flex-wrap">
          {urgencyOptions.map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUrgency(u)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium border transition-colors',
                urgency === u
                  ? urgencyBadgeClass(u) + ' border-transparent'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              )}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Complexity</label>
        <div className="flex gap-1.5">
          {complexityOptions.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setComplexity(c)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium border transition-colors',
                complexity === c
                  ? 'bg-primary text-primary-foreground border-transparent'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={submitting || !description.trim()}>
          {submitting ? 'Creating…' : 'Create Task'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ─── Task Card ────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: Task
  onRefresh: () => void
}

function TaskCard({ task, onRefresh }: TaskCardProps) {
  const shortId = task.id.slice(0, 8)
  const [resolvingBid, setResolvingBid] = React.useState(false)

  const hasBids = task.bids.length > 0

  async function handleResolveBidding() {
    if (!isTauri()) return
    setResolvingBid(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_resolve_bidding', { taskId: task.id })
      onRefresh()
    } catch (err) {
      console.warn('[SuperAgent] Failed to resolve bidding:', err)
    } finally {
      setResolvingBid(false)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4 transition-all">
      <div className="flex items-start gap-3">
        {/* Status dot */}
        <div className="mt-1.5 flex-shrink-0">
          <span
            className={cn('block h-2.5 w-2.5 rounded-full', statusDotClass(task.status))}
            title={task.status}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {/* Top row: status label + urgency badge */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {statusLabel(task.status)}
            </span>
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-xs leading-none font-medium',
                urgencyBadgeClass(task.urgency),
              )}
            >
              {task.urgency}
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground/60">
              #{shortId}
            </span>
          </div>

          {/* Description */}
          <p className="text-sm leading-snug">{task.description}</p>

          {/* Capability tags */}
          {task.requiredCapabilities.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {task.requiredCapabilities.map((cap) => (
                <span
                  key={cap}
                  className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {cap}
                </span>
              ))}
            </div>
          )}

          {/* Footer: creator, assignee, bid count */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              Creator: <span className="font-medium">{task.creator.slice(0, 12)}</span>
            </span>
            {task.assignee && (
              <span>
                Assignee: <span className="font-medium">{task.assignee.slice(0, 12)}</span>
              </span>
            )}
            {task.bids.length > 0 && (
              <span>{task.bids.length} bid{task.bids.length !== 1 ? 's' : ''}</span>
            )}
            {task.result && (
              <span className="text-green-600 dark:text-green-400">
                Score: {task.result.score}
              </span>
            )}
          </div>

          {/* Resolve Bidding button */}
          {task.status === 'bidding' && hasBids && (
            <div className="pt-1">
              <Button
                size="xs"
                variant="outline"
                onClick={handleResolveBidding}
                disabled={resolvingBid}
              >
                {resolvingBid ? 'Selecting…' : 'Select Winner'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Active Status Set ────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set<TaskStatus>(['open', 'bidding', 'assigned', 'running'])

// ─── Main Component ───────────────────────────────────────────────────────────

export function TaskBoard() {
  const taskBoard = useSuperAgentStore((s) => s.taskBoard)
  const fetchTasks = useSuperAgentStore((s) => s.fetchTasks)
  const [showForm, setShowForm] = React.useState(false)

  React.useEffect(() => {
    fetchTasks()
    const id = setInterval(fetchTasks, 5000)
    return () => clearInterval(id)
  }, [fetchTasks])

  const activeTasks = taskBoard.tasks.filter((t) => ACTIVE_STATUSES.has(t.status))
  const completedTasks = taskBoard.tasks.filter((t) => !ACTIVE_STATUSES.has(t.status))

  return (
    <div className="space-y-6">
      {/* Create Task form / button */}
      <div className="space-y-3">
        {showForm ? (
          <CreateTaskForm onClose={() => setShowForm(false)} />
        ) : (
          <Button size="sm" onClick={() => setShowForm(true)}>
            Create Task
          </Button>
        )}
      </div>

      {/* Active tasks section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Active Tasks</p>
            {activeTasks.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {activeTasks.length} task{activeTasks.length !== 1 ? 's' : ''} in progress
              </p>
            )}
          </div>
        </div>

        {activeTasks.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">No active tasks</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeTasks.map((task) => (
              <TaskCard key={task.id} task={task} onRefresh={fetchTasks} />
            ))}
          </div>
        )}
      </div>

      {/* Completed tasks section */}
      {completedTasks.length > 0 && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Completed</p>
          </div>
          <div className="space-y-2">
            {completedTasks.map((task) => (
              <TaskCard key={task.id} task={task} onRefresh={fetchTasks} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
