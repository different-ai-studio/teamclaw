import { getBackend } from '@/lib/backend'

export type IdeaStatus = 'open' | 'in_progress' | 'done'

interface IdeaForUpdate {
  workspace_id: string | null
  title: string
  description: string | null
  status: IdeaStatus | null
}

interface IdeaUpdateInput {
  workspaceId: string | null
  title: string
  description: string | null
  status: IdeaStatus
}

interface IdeaActivityInput {
  activityType: 'progress' | 'status_change' | 'reorder'
  content: string
  metadata?: Record<string, string>
}

async function fetchIdeaForUpdate(ideaId: string): Promise<IdeaForUpdate> {
  const data = await getBackend().ideas.getIdeaDetail(ideaId)
  if (!data) throw new Error('idea not found')
  return {
    workspace_id: data.workspace_id ?? null,
    title: data.title,
    description: data.description ?? null,
    status: (data.status as IdeaStatus | null) ?? null,
  }
}

export async function updateIdeaStatus(ideaId: string, status: IdeaStatus): Promise<void> {
  const cur = await fetchIdeaForUpdate(ideaId)
  await updateIdea(ideaId, {
    workspaceId: cur.workspace_id,
    title: cur.title,
    description: cur.description,
    status,
  })
}

export async function renameIdea(ideaId: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title is required')
  const cur = await fetchIdeaForUpdate(ideaId)
  await updateIdea(ideaId, {
    workspaceId: cur.workspace_id,
    title: trimmed,
    description: cur.description,
    status: cur.status ?? 'open',
  })
}

export async function updateIdea(ideaId: string, input: IdeaUpdateInput): Promise<void> {
  const trimmed = input.title.trim()
  if (!trimmed) throw new Error('title is required')
  await getBackend().ideas.updateIdea({
    ideaId,
    workspaceId: input.workspaceId,
    title: trimmed,
    description: input.description,
    status: input.status,
  })
}

export async function createIdeaActivity(ideaId: string, input: IdeaActivityInput): Promise<void> {
  await getBackend().ideas.createIdeaActivity({
    ideaId,
    activityType: input.activityType,
    content: input.content,
    metadata: input.metadata ?? {},
  })
}
