import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileText } from 'lucide-react'
import { ToolCallDisclosure } from '../ToolCallDisclosure'

describe('ToolCallDisclosure', () => {
  it('fully hides details when collapsed and joins them to the header when expanded', () => {
    render(
      <ToolCallDisclosure
        testId="tool-disclosure"
        contentTestId="tool-disclosure-content"
        icon={<FileText />}
        title="Read"
        target="packages/app/src/App.tsx"
      >
        <div>file contents</div>
      </ToolCallDisclosure>,
    )

    const disclosure = screen.getByTestId('tool-disclosure')
    const trigger = disclosure.querySelector('[data-slot="collapsible-trigger"]')

    expect(disclosure).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByTestId('tool-disclosure-content')).toBeNull()
    expect(trigger?.className).not.toContain('hover:bg-')
    expect(fireEvent.mouseDown(trigger!)).toBe(false)
    expect(disclosure.className).toContain('border-transparent')
    expect(disclosure.className).not.toContain('my-')
    const closedTriggerClassName = trigger?.className

    fireEvent.click(trigger!)

    expect(disclosure).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('tool-disclosure-content')).toHaveTextContent('file contents')
    expect(disclosure.className).toContain('overflow-hidden')
    expect(trigger?.className).toBe(closedTriggerClassName)
  })

  it('keeps the target action clickable without toggling the disclosure', () => {
    const onTargetClick = vi.fn()
    render(
      <ToolCallDisclosure
        testId="tool-disclosure"
        icon={<FileText />}
        title="Read"
        target="packages/app/src/App.tsx"
        onTargetClick={onTargetClick}
      >
        <div>file contents</div>
      </ToolCallDisclosure>,
    )

    const target = screen.getByRole('button', { name: 'packages/app/src/App.tsx' })
    fireEvent.mouseDown(target)
    fireEvent.click(target)

    expect(onTargetClick).toHaveBeenCalledOnce()
    expect(screen.getByTestId('tool-disclosure')).toHaveAttribute('data-state', 'closed')
  })
})
