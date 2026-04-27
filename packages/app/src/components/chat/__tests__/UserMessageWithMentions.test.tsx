import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserMessageWithMentions } from '../UserMessageWithMentions'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@/packages/ai/message', () => ({
  ClickableImage: () => null,
  LocalImage: () => null,
  resolveImagePath: (path: string) => path,
}))

vi.mock('@/packages/ai/chip-labels', () => ({
  getTrailingPathLabel: (path: string) => path.split('/').filter(Boolean).pop() ?? path,
}))

describe('UserMessageWithMentions', () => {
  it('renders role markers as role chips', () => {
    render(<UserMessageWithMentions content="[Role: accounting-dimensions]" />)

    expect(screen.getByText('accounting-dimensions')).toBeTruthy()
  })

  it('hides role activation helper text while keeping the role chip visible', () => {
    render(
      <UserMessageWithMentions content={'[Role: apcc-issue-operator]\n\nFirst tool call: role_load({ name: "apcc-issue-operator" }).'} />,
    )

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
    expect(screen.queryByText(/First tool call: role_load/)).toBeNull()
  })

  it('renders enhanced role chips without exposing hidden tool metadata', () => {
    render(
      <UserMessageWithMentions content={'[Role: apcc-issue-operator|instruction:You must call role_load({ name: "apcc-issue-operator" }) before any other action.]'} />,
    )

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
    expect(screen.queryByText(/role_load/)).toBeNull()
  })

  it('renders enhanced skill chips without exposing hidden tool metadata', () => {
    render(
      <UserMessageWithMentions content={'[Skill: session-distiller|instruction:You must call skill({ name: "session-distiller" }) before any other action.] 把我的输入原样返回给我'} />,
    )

    expect(screen.getByText('session-distiller')).toBeTruthy()
    expect(screen.queryByText(/First tool call/)).toBeNull()
    expect(screen.queryByText(/skill\(\{/)).toBeNull()
    expect(screen.getByText('把我的输入原样返回给我')).toBeTruthy()
  })

  it('renders unified slash role tokens as role chips', () => {
    render(<UserMessageWithMentions content="/{role:apcc-issue-operator}" />)

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
  })
})
