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

  it('renders unified slash role tokens as role chips', () => {
    render(<UserMessageWithMentions content="/{role:apcc-issue-operator}" />)

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
  })
})
