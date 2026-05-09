import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditableWithFileChips } from '../editable-with-file-chips'

const originalExecCommand = document.execCommand

afterEach(() => {
  document.execCommand = originalExecCommand
  vi.restoreAllMocks()
})

function TestHarness({ initialValue }: { initialValue: string }) {
  const [value, setValue] = React.useState(initialValue)

  return (
    <div>
      <EditableWithFileChips value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  )
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange()
  const selection = window.getSelection()
  range.selectNodeContents(element)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('EditableWithFileChips', () => {
  it('deletes adjacent chips with one Backspace per chip from the end', async () => {
    render(
      <TestHarness initialValue="/{role:apcc-issue-operator} /{skill:verification-before-completion} /{command:review} " />,
    )

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editable).toBeTruthy()

    placeCaretAtEnd(editable)

    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe(
        '/{role:apcc-issue-operator} /{skill:verification-before-completion} ',
      )
    })

    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('/{role:apcc-issue-operator} ')
    })

    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
  })

  it('serializes Chromium native trailing line-break placeholder as one newline', async () => {
    render(<TestHarness initialValue="" />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    editable.append(
      document.createTextNode('hello'),
      document.createTextNode('\n'),
      document.createTextNode('\n'),
    )
    fireEvent.input(editable)

    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('hello\n')
    })
  })

  it('keeps an existing single text-node trailing newline', async () => {
    render(<TestHarness initialValue={'hello\n'} />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editable.childNodes).toHaveLength(1)
    fireEvent.input(editable)

    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('hello\n')
    })
  })

  it('does not block native line-break beforeinput events', () => {
    render(<TestHarness initialValue="hello" />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: '\n',
      inputType: 'insertLineBreak',
    })

    editable.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('uses the browser line-break command for Shift+Enter', async () => {
    document.execCommand = vi.fn((command: string) => command === 'insertLineBreak') as typeof document.execCommand

    render(<TestHarness initialValue="hello" />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    placeCaretAtEnd(editable)
    fireEvent.keyDown(editable, { key: 'Enter', shiftKey: true })

    expect(document.execCommand).toHaveBeenCalledWith('insertLineBreak')
  })
})
