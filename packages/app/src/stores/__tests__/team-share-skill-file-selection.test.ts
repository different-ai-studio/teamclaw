import { describe, test, expect, beforeEach } from 'vitest'
import { useTeamShareBrowserStore } from '../team-share-browser'
import { useTabsStore } from '../tabs'

const store = () => useTeamShareBrowserStore.getState()
const tabs = () => useTabsStore.getState()
const targets = () => tabs().tabs.map((t) => t.target)
const detailTarget = () => store().detailTarget

describe('team-share selection lives in the detail pane', () => {
  beforeEach(() => {
    tabs().closeAll()
    store().clearDetail()
  })

  test('opening a skill selects it without creating a tab', () => {
    store().select('skills', 'deploy-check')
    expect(detailTarget()).toEqual({ kind: 'skill', id: 'deploy-check' })
    expect(targets()).toEqual([])
  })

  test('clicking another package file replaces the current detail', () => {
    store().selectSkillFile('deploy-check', 'SKILL.md')
    store().selectSkillFile('deploy-check', 'scripts/check.sh')
    expect(detailTarget()).toEqual({
      kind: 'skill-file',
      id: 'deploy-check',
      rel: 'scripts/check.sh',
    })
    expect(targets()).toEqual([])
  })

  test('clicking an item in another section replaces the current detail', () => {
    store().select('skills', 'deploy-check')
    store().select('mcp', 'context7')
    expect(detailTarget()).toEqual({ kind: 'mcp', name: 'context7' })
    expect(targets()).toEqual([])
  })

  test('deselecting a section only clears a detail owned by that section', () => {
    store().select('skills', 'deploy-check')
    store().select('mcp', 'context7')

    store().select('skills', null)
    expect(detailTarget()).toEqual({ kind: 'mcp', name: 'context7' })

    store().select('mcp', null)
    expect(detailTarget()).toBeNull()
  })

  test('deleting a directory clears an active file inside it', () => {
    store().selectSkillFile('deploy-check', 'scripts/nested/run.sh')

    store().closeSkillFiles('deploy-check', 'scripts')

    expect(detailTarget()).toBeNull()
  })

  test('knowledge documents keep their existing file-tab behavior', () => {
    store().select('knowledge', '/team/knowledge/spec.md')
    expect(detailTarget()).toBeNull()
    expect(targets()).toEqual([])
  })
})
