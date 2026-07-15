import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIdeaActivity, updateIdea, updateIdeaStatus, renameIdea } from '../idea-mutations'

const getIdeaDetailMock = vi.fn()
const updateIdeaMock = vi.fn()
const createIdeaActivityMock = vi.fn()

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    ideas: {
      getIdeaDetail: getIdeaDetailMock,
      updateIdea: updateIdeaMock,
      createIdeaActivity: createIdeaActivityMock,
    },
  }),
}))

beforeEach(() => {
  getIdeaDetailMock.mockReset()
  updateIdeaMock.mockReset()
  createIdeaActivityMock.mockReset()
  updateIdeaMock.mockResolvedValue(undefined)
  createIdeaActivityMock.mockResolvedValue(undefined)
})

describe('updateIdeaStatus', () => {
  it('reads the full idea then calls update_idea with new status', async () => {
    getIdeaDetailMock.mockResolvedValue({ workspace_id: 'ws-1', title: 'T', description: 'D', status: 'open' })

    await updateIdeaStatus('idea-1', 'in_progress')

    expect(updateIdeaMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      workspaceId: 'ws-1',
      title: 'T',
      description: 'D',
      status: 'in_progress',
    })
  })

  it('throws when fetch fails', async () => {
    getIdeaDetailMock.mockRejectedValue(new Error('not found'))
    await expect(updateIdeaStatus('idea-1', 'done')).rejects.toThrow('not found')
    expect(updateIdeaMock).not.toHaveBeenCalled()
  })

  it('throws when rpc errors', async () => {
    getIdeaDetailMock.mockResolvedValue({ workspace_id: null, title: 'T', description: null, status: null })
    updateIdeaMock.mockRejectedValue(new Error('rpc failed'))
    await expect(updateIdeaStatus('idea-1', 'done')).rejects.toThrow('rpc failed')
  })
})

describe('renameIdea', () => {
  it('trims and writes new title with existing status fallback to open', async () => {
    getIdeaDetailMock.mockResolvedValue({ workspace_id: 'ws-1', title: 'old', description: 'D', status: null })

    await renameIdea('idea-1', '  new title  ')

    expect(updateIdeaMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      workspaceId: 'ws-1',
      title: 'new title',
      description: 'D',
      status: 'open',
    })
  })

  it('rejects empty / whitespace title', async () => {
    await expect(renameIdea('idea-1', '   ')).rejects.toThrow('title is required')
    expect(getIdeaDetailMock).not.toHaveBeenCalled()
  })
})

describe('updateIdea', () => {
  it('calls update_idea with explicit editable fields', async () => {
    await updateIdea('idea-1', {
      workspaceId: null,
      title: ' Edited ',
      description: 'Details',
      status: 'done',
    })

    expect(updateIdeaMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      workspaceId: null,
      title: 'Edited',
      description: 'Details',
      status: 'done',
    })
  })
})

describe('createIdeaActivity', () => {
  it('calls create_idea_activity with progress content', async () => {
    await createIdeaActivity('idea-1', {
      activityType: 'progress',
      content: 'shipped first pass',
    })

    expect(createIdeaActivityMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      activityType: 'progress',
      content: 'shipped first pass',
      metadata: {},
    })
  })
})
