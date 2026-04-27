import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'

let shouldThrowMarkdown = false
const mermaidInitializeMock = vi.fn()
const mermaidRenderMock = vi.fn(async (id: string, code: string) => ({
  svg: `<svg data-testid="mermaid-svg" data-diagram-id="${id}"><text>${code}</text></svg>`,
}))

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
  default: ({
    children,
    components,
  }: {
    children: string
    components?: {
      code?: (props: { className?: string; children?: React.ReactNode }) => React.ReactNode
    }
  }) => {
    if (shouldThrowMarkdown) {
      throw new Error('Invalid regular expression: invalid group specifier name')
    }

    const mermaidMatch = children.match(/^```(\w+)\n([\s\S]*?)\n```$/)
    if (mermaidMatch && components?.code) {
      return React.createElement(
        'div',
        { 'data-testid': 'markdown' },
        components.code({
          className: `language-${mermaidMatch[1]}`,
          children: mermaidMatch[2],
        }),
      )
    }

    return React.createElement('div', { 'data-testid': 'markdown' }, children)
  },
}))

vi.mock('remark-gfm', () => ({
  default: () => {},
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}))

vi.mock('lucide-react', () => ({
  Download: () => React.createElement('span', null, 'Download'),
  X: () => React.createElement('span', null, 'X'),
  Copy: () => React.createElement('span', null, 'Copy'),
  Check: () => React.createElement('span', null, 'Check'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  shouldThrowMarkdown = false
  document.documentElement.classList.remove('dark')
  mermaidRenderMock.mockImplementation(async (id: string, code: string) => ({
    svg: `<svg data-testid="mermaid-svg" data-diagram-id="${id}"><text>${code}</text></svg>`,
  }))
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

  it('renders mermaid fenced code with a diagram container instead of a plain code block', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const mermaidSource = [
      '```mermaid',
      'flowchart LR',
      '  A[Start] --> B[Done]',
      '```',
    ].join('\n')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, mermaidSource)
        )
      )
    )

    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="mermaid-svg"]')).toBeTruthy()
    })
    expect(container.querySelector('pre')).toBeNull()
  })

  it('falls back to a normal mermaid code block when diagram rendering fails', async () => {
    mermaidRenderMock.mockRejectedValueOnce(new Error('render failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const mermaidSource = [
      '```mermaid',
      'flowchart LR',
      '  A[Broken] --> B[Fallback]',
      '```',
    ].join('\n')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, mermaidSource)
        )
      )
    )

    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull()
      expect(container.querySelector('pre')).toBeTruthy()
      expect(container.querySelector('code')?.textContent).toContain('flowchart LR')
    })
    expect(warnSpy).toHaveBeenCalledWith(
      '[MessageResponse] Mermaid render failed, falling back to code block',
      expect.any(Error),
    )

    warnSpy.mockRestore()
  })

  it('uses the dark mermaid theme when the document is in dark mode', async () => {
    document.documentElement.classList.add('dark')
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, '```mermaid\nflowchart LR\nA --> B\n```')
        )
      )
    )

    await waitFor(() => {
      expect(mermaidInitializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
    })
  })

  it('keeps non-mermaid fenced code on the normal code block path', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, '```typescript\nconst answer = 42\n```')
        )
      )
    )

    expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull()
    expect(container.querySelector('pre')).toBeTruthy()
    expect(screen.getByText('const answer = 42')).toBeTruthy()
    expect(mermaidRenderMock).not.toHaveBeenCalled()
  })
})
