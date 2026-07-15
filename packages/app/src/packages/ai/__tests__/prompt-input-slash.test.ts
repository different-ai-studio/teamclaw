import { describe, expect, it } from 'vitest'
import { getCommandTriggerContext } from '../prompt-input'

describe('getCommandTriggerContext', () => {
  it('treats a slash typed immediately after a role token as a new trigger', () => {
    expect(getCommandTriggerContext('/{role:apcc-issue-operator}/', '/{role:apcc-issue-operator}/'.length)).toEqual({
      index: '/{role:apcc-issue-operator}'.length,
      query: '',
    })
  })

  it('treats a slash typed immediately after a skill token as a new trigger', () => {
    expect(getCommandTriggerContext('/{skill:brainstorming}/', '/{skill:brainstorming}/'.length)).toEqual({
      index: '/{skill:brainstorming}'.length,
      query: '',
    })
  })

  it('does not reopen the picker for an existing role token itself', () => {
    expect(getCommandTriggerContext('/{role:apcc-issue-operator}', '/{role:apcc-issue-operator}'.length)).toBeNull()
  })
})
