import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallCard } from '../ToolCallCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  }),
}))

describe('ToolCallCard', () => {
  it('shows the ACP command intent stored in _description', () => {
    render(
      <ToolCallCard
        toolCall={{
          id: 'bash-1',
          name: 'Bash',
          toolKind: 'execute',
          status: 'completed',
          arguments: {
            _description: 'List workspace files',
            command: 'ls -la',
          },
          duration: 120,
          startTime: new Date(),
        }}
      />,
    )

    expect(screen.getByText('List workspace files')).toBeInTheDocument()
    expect(screen.queryByText('Execute command')).not.toBeInTheDocument()
  })

  it('recovers the completed command title from raw output', () => {
    render(
      <ToolCallCard
        toolCall={{
          id: 'bash-2',
          name: 'bash',
          toolKind: 'execute',
          status: 'completed',
          arguments: { command: 'pnpm typecheck' },
          rawOutput: {
            status: 'completed',
            title: 'Validate TypeScript types',
          },
          startTime: new Date(),
        }}
      />,
    )

    expect(screen.getByText('Validate TypeScript types')).toBeInTheDocument()
  })

  it('shows the command while an intent description is unavailable', () => {
    render(
      <ToolCallCard
        toolCall={{
          id: 'bash-3',
          name: 'bash',
          toolKind: 'execute',
          status: 'calling',
          arguments: { command: 'ps' },
          startTime: new Date(),
        }}
      />,
    )

    expect(screen.getByText('ps')).toBeInTheDocument()
    expect(screen.queryByText('Execute command')).not.toBeInTheDocument()
  })
})
