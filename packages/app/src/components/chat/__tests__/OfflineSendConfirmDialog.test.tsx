import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OfflineSendConfirmDialog } from '../OfflineSendConfirmDialog'

describe('OfflineSendConfirmDialog', () => {
  it('does not describe a runtime startup failure as offline', () => {
    render(
      <OfflineSendConfirmDialog
        open
        onOpenChange={() => {}}
        entries={[{
          agent: { id: 'agent-1', displayName: 'Build Bot' },
          uiState: 'runtime-error',
        }]}
        onConfirm={() => {}}
        dismissForSession={false}
        onDismissForSessionChange={() => {}}
      />,
    )

    expect(screen.getByText(/启动失败|failed to start/i)).toBeInTheDocument()
    expect(screen.queryByText(/当前离线|is offline/i)).not.toBeInTheDocument()
  })
})
