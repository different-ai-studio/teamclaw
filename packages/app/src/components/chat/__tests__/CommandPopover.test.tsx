import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPopover } from '../CommandPopover'

const { mockListCommands, mockLoadAllSkills, mockReadSkillPermissions } = vi.hoisted(() => ({
  mockListCommands: vi.fn(),
  mockLoadAllSkills: vi.fn(),
  mockReadSkillPermissions: vi.fn(),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isTauri: () => true,
  }
})

vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: () => ({
    listCommands: mockListCommands,
  }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string }) => unknown) =>
    selector({ workspacePath: '/workspace/project' }),
}))

vi.mock('@/lib/git/skill-loader', () => ({
  loadAllSkills: mockLoadAllSkills,
}))

vi.mock('@/lib/opencode/config', () => ({
  readSkillPermissions: mockReadSkillPermissions,
  resolveSkillPermission: () => ({ permission: 'allow', matchedPattern: '*', isExact: false }),
}))

describe('CommandPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListCommands.mockResolvedValue([])
    mockReadSkillPermissions.mockResolvedValue({})
    mockLoadAllSkills.mockResolvedValue({
      skills: [
        {
          filename: 'brainstorming',
          name: 'brainstorming',
          invocationName: 'superpowers/brainstorming',
          content: '---\ndescription: Brainstorm first\n---\n',
          source: 'global-agent',
          dirPath: '/home/user/.agents/skills/superpowers',
        },
      ],
      overrides: [],
    })
  })

  it('shows invocation name for bundled skills and selects namespaced invocation', async () => {
    const onSelect = vi.fn()

    render(
      <CommandPopover
        open={true}
        onOpenChange={vi.fn()}
        searchQuery="brain"
        onSelect={onSelect}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('brainstorming')).toBeTruthy()
    })

    expect(screen.getByText('superpowers/brainstorming')).toBeTruthy()

    fireEvent.click(screen.getByText('brainstorming'))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'superpowers/brainstorming',
        description: 'Brainstorm first',
      }),
    )
  })
})
