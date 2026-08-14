import { describe, test, expect, beforeEach } from 'vitest'
import { useTeamShareBrowserStore } from '../team-share-browser'
import { useTabsStore } from '../tabs'

const store = () => useTeamShareBrowserStore.getState()
const tabs = () => useTabsStore.getState()
const targets = () => tabs().tabs.map((t) => t.target)
const activeTarget = () => tabs().getActiveTab()?.target ?? null

describe('team-share selection lives in the tabs', () => {
  beforeEach(() => {
    tabs().closeAll()
  })

  test('opening a skill opens a tab addressed by its id', () => {
    store().select('skills', 'deploy-check')
    expect(activeTarget()).toBe('teamshare:skill/deploy-check')
  })

  test('a package file gets its own tab, so two can be open at once', () => {
    // The whole point of the tab move: SKILL.md and a script side by side.
    store().selectSkillFile('deploy-check', 'SKILL.md')
    store().selectSkillFile('deploy-check', 'scripts/check.sh')
    expect(targets()).toEqual([
      'teamshare:skill-file/deploy-check/SKILL.md',
      'teamshare:skill-file/deploy-check/scripts/check.sh',
    ])
    expect(activeTarget()).toBe('teamshare:skill-file/deploy-check/scripts/check.sh')
  })

  test('re-opening something already open activates it instead of duplicating', () => {
    store().select('skills', 'deploy-check')
    store().select('mcp', 'context7')
    store().select('skills', 'deploy-check')
    expect(targets()).toEqual(['teamshare:skill/deploy-check', 'teamshare:mcp/context7'])
    expect(activeTarget()).toBe('teamshare:skill/deploy-check')
  })

  test('deselecting a section closes what that section had open', () => {
    store().select('skills', 'deploy-check')
    store().select('mcp', 'context7')

    store().select('skills', null)

    // Only the skills tab goes; another section's tab is not this one's business.
    expect(targets()).toEqual(['teamshare:mcp/context7'])
  })

  test('deleting a directory closes the tabs of the files inside it', () => {
    store().selectSkillFile('deploy-check', 'SKILL.md')
    store().selectSkillFile('deploy-check', 'scripts/check.sh')
    store().selectSkillFile('deploy-check', 'scripts/nested/run.sh')

    store().closeSkillFiles('deploy-check', 'scripts')

    expect(targets()).toEqual(['teamshare:skill-file/deploy-check/SKILL.md'])
  })

  test('knowledge documents are not addressed here', () => {
    // They are plain file tabs, opened through the workspace's own selectFile.
    store().select('knowledge', '/team/knowledge/spec.md')
    expect(targets()).toEqual([])
  })
})
