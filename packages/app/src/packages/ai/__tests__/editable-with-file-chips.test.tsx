import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { EditableWithFileChips } from '../editable-with-file-chips'

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
})
