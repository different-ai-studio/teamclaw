import { describe, test, expect, beforeEach } from 'vitest'
import { useTeamShareBrowserStore } from '../team-share-browser'

const store = () => useTeamShareBrowserStore.getState()

describe('skill file selection', () => {
  beforeEach(() => {
    store().select('skills', null)
    store().selectSkillFile(null)
  })

  test('a file is remembered alongside the skill that owns it', () => {
    store().select('skills', 'deploy-check')
    store().selectSkillFile('scripts/check.sh')
    expect(store().selectedId.skills).toBe('deploy-check')
    expect(store().selectedSkillFile).toBe('scripts/check.sh')
  })

  test('moving to another skill drops the open file', () => {
    store().select('skills', 'deploy-check')
    store().selectSkillFile('scripts/check.sh')
    store().select('skills', 'pr-review')
    // `scripts/check.sh` names a file inside deploy-check. Carried over, it
    // would point at a different package's file or at nothing at all.
    expect(store().selectedSkillFile).toBeNull()
  })

  test('re-selecting the same skill keeps the file open', () => {
    // The list column re-selects the row a file belongs to whenever that file
    // is clicked; clearing here would close the editor on every click.
    store().select('skills', 'deploy-check')
    store().selectSkillFile('scripts/check.sh')
    store().select('skills', 'deploy-check')
    expect(store().selectedSkillFile).toBe('scripts/check.sh')
  })

  test('selecting in another section leaves the skill file alone', () => {
    store().select('skills', 'deploy-check')
    store().selectSkillFile('SKILL.md')
    store().select('mcp', 'context7')
    expect(store().selectedSkillFile).toBe('SKILL.md')
  })
})
