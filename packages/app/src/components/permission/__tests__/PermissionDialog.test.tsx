import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PermissionDialog } from '../PermissionDialog'
import type { PermissionAskedEvent } from '@/lib/opencode/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

const mockPermission: PermissionAskedEvent = {
  id: 'perm-1',
  sessionID: 'sess-1',
  permission: 'write',
  patterns: ['/src/file.ts'],
  metadata: { file: '/src/file.ts' },
}

describe('PermissionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('displays permission dialog content when permission is provided', () => {
    const onReply = vi.fn()
    render(<PermissionDialog permission={mockPermission} onReply={onReply} />)
    expect(screen.getByText('Permission Request')).toBeTruthy()
    expect(screen.getByText('Write')).toBeTruthy()
  })

  it('calls onReply with allow when Allow Once is clicked', () => {
    const onReply = vi.fn()
    render(<PermissionDialog permission={mockPermission} onReply={onReply} />)
    fireEvent.click(screen.getByText('Allow Once'))
    expect(onReply).toHaveBeenCalledWith('allow')
  })

  it('calls onReply with deny when Deny is clicked', () => {
    const onReply = vi.fn()
    render(<PermissionDialog permission={mockPermission} onReply={onReply} />)
    fireEvent.click(screen.getByText('Deny'))
    expect(onReply).toHaveBeenCalledWith('deny')
  })

  it('calls onReply with always when Always Allow is clicked', () => {
    const onReply = vi.fn()
    render(<PermissionDialog permission={mockPermission} onReply={onReply} />)
    fireEvent.click(screen.getByText('Always Allow'))
    expect(onReply).toHaveBeenCalledWith('always')
  })
})
