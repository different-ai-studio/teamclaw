import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

let shouldThrowMarkdown = false

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('not found')),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    if (shouldThrowMarkdown) {
      throw new Error('Invalid regular expression: invalid group specifier name')
    }
    return React.createElement('div', { 'data-testid': 'markdown' }, children)
  },
}))

vi.mock('remark-gfm', () => ({
  default: () => {},
}))

vi.mock('lucide-react', () => ({
  Download: () => React.createElement('span', null, 'Download'),
  X: () => React.createElement('span', null, 'X'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  shouldThrowMarkdown = false
})

describe('Message', () => {
  it('renders user message with justify-end', async () => {
    const { Message, MessageContent } = await import('@/packages/ai/message')
    const { container } = render(
      React.createElement(Message, { from: 'user' },
        React.createElement(MessageContent, null, 'Hello')
      )
    )
    const messageDiv = container.firstElementChild
    expect(messageDiv?.className).toContain('justify-end')
  })

  it('renders assistant message with justify-start', async () => {
    const { Message, MessageContent } = await import('@/packages/ai/message')
    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null, 'Hi there')
      )
    )
    const messageDiv = container.firstElementChild
    expect(messageDiv?.className).toContain('justify-start')
  })
})

describe('resolveImagePath', () => {
  it('returns data URLs unchanged', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })

  it('returns http URLs unchanged', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('https://example.com/img.png')).toBe('https://example.com/img.png')
  })

  it('resolves relative paths with basePath', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('img.png', '/workspace')).toBe('/workspace/img.png')
  })

  it('returns absolute paths unchanged', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('/absolute/path.png')).toBe('/absolute/path.png')
  })
})

describe('MessageBranch components', () => {
  it('renders MessageBranch, MessageBranchContent, MessageBranchSelector', async () => {
    const { MessageBranch, MessageBranchContent, MessageBranchSelector, MessageBranchPage } =
      await import('@/packages/ai/message')
    render(
      React.createElement(MessageBranch, null,
        React.createElement(MessageBranchContent, null, 'content'),
        React.createElement(MessageBranchSelector, null,
          React.createElement(MessageBranchPage, null, '1 / 2')
        )
      )
    )
    expect(screen.getByText('content')).toBeDefined()
    expect(screen.getByText('1 / 2')).toBeDefined()
  })
})

describe('image preview rendering', () => {
  it('renders SVG previews with an iframe canvas', async () => {
    const { ClickableImage } = await import('@/packages/ai/message')
    const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'

    const { container } = render(
      React.createElement(ClickableImage, {
        src: svgDataUrl,
        alt: 'diagram.svg',
      })
    )

    const iframe = container.querySelector('iframe[title="diagram.svg"]')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('src')).toBe(svgDataUrl)
  })

  it('renders bitmap previews with img tags', async () => {
    const { ClickableImage } = await import('@/packages/ai/message')
    const pngDataUrl = 'data:image/png;base64,abc'

    render(
      React.createElement(ClickableImage, {
        src: pngDataUrl,
        alt: 'photo.png',
      })
    )

    const images = screen.getAllByAltText('photo.png')
    expect(images.length).toBeGreaterThan(0)
    expect(images[0].getAttribute('src')).toBe(pngDataUrl)
  })
})

describe('MessageResponse', () => {
  it('falls back to plain text when markdown rendering throws', async () => {
    shouldThrowMarkdown = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, 'hello **world**')
        )
      )
    )

    expect(screen.getByText('hello **world**')).toBeDefined()
    expect(screen.queryByTestId('markdown')).toBeNull()

    warnSpy.mockRestore()
  })
})
