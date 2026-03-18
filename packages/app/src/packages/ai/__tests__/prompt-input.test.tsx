import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@/packages/ai/editable-with-file-chips', () => ({
  EditableWithFileChips: React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) =>
      React.createElement('div', { ref, 'data-testid': 'editable', role: 'textbox' })
  ),
}))

vi.mock('@/packages/ai/prompt-input-ui', () => ({
  PromptInputTools: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputButton: ({ children }: React.PropsWithChildren) => React.createElement('button', null, children),
  PromptInputSubmit: ({ children }: React.PropsWithChildren) => React.createElement('button', { type: 'submit' }, children),
  PromptInputActionMenu: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputActionMenuTrigger: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputActionMenuContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputAttachment: () => null,
  createAttachmentComponents: () => ({
    PromptInputActionAddAttachments: () => null,
    PromptInputAttachments: () => null,
    PromptInputMentions: () => null,
  }),
}))

vi.mock('@/packages/ai/prompt-input-types', () => ({}))

vi.mock('@/packages/ai/prompt-input-insert-hooks', () => ({
  useInsertMentionHook: () => vi.fn(),
  useInsertFileMentionHook: () => vi.fn(),
  useInsertSkillMentionHook: () => vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PromptInput', () => {
  it('renders a form element', async () => {
    const { PromptInput } = await import('@/packages/ai/prompt-input')
    const { container } = render(
      React.createElement(PromptInput, null, React.createElement('div', null, 'child'))
    )
    const form = container.querySelector('form')
    expect(form).toBeDefined()
    expect(form).not.toBeNull()
  })

  it('renders children inside the form', async () => {
    const { PromptInput } = await import('@/packages/ai/prompt-input')
    render(
      React.createElement(PromptInput, null,
        React.createElement('span', null, 'test content')
      )
    )
    expect(screen.getByText('test content')).toBeDefined()
  })
})

describe('PromptInputHeader / Body / Footer', () => {
  it('renders header, body, footer as divs', async () => {
    const { PromptInput, PromptInputHeader, PromptInputBody, PromptInputFooter } =
      await import('@/packages/ai/prompt-input')
    render(
      React.createElement(PromptInput, null,
        React.createElement(PromptInputHeader, null, 'header'),
        React.createElement(PromptInputBody, null, 'body'),
        React.createElement(PromptInputFooter, null, 'footer'),
      )
    )
    expect(screen.getByText('header')).toBeDefined()
    expect(screen.getByText('body')).toBeDefined()
    expect(screen.getByText('footer')).toBeDefined()
  })
})

describe('usePromptInputContext', () => {
  it('throws when used outside PromptInput', async () => {
    const { usePromptInputContext } = await import('@/packages/ai/prompt-input')
    expect(() => {
      // Call the hook outside provider
      const TestComponent = () => {
        usePromptInputContext()
        return null
      }
      render(React.createElement(TestComponent))
    }).toThrow('PromptInput components must be used within <PromptInput />')
  })
})
