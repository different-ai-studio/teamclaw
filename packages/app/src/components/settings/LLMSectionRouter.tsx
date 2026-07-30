import * as React from 'react'
import { getDaemonLocalAgent, type DaemonLocalAgent } from '@/lib/daemon-local-client'
import { isTauri } from '@/lib/utils'
import { OpenCodeLLMSection } from './LLMSection'
import { PiLLMSection } from './PiLLMSection'
import { CursorLLMSection } from './CursorLLMSection'
import { ClaudeLLMSection } from './ClaudeLLMSection'

/**
 * LLM settings dispatcher. The local agent runtime determines both the logic
 * and the layout: opencode configures providers via opencode.json / opencode
 * serve (connect, OAuth, custom providers); pi owns its own credentials on the
 * host (`pi /login`) and only exposes a read-only model catalog. We branch on
 * `agents.local_agent` so each runtime gets its own pane.
 *
 * pi, cursor and claude-code all own their credentials outside opencode.json, so
 * their panes are read-only catalogs; only opencode gets the provider UI.
 */
export function LLMSection() {
  const [agent, setAgent] = React.useState<DaemonLocalAgent | null>(null)

  React.useEffect(() => {
    let alive = true
    if (!isTauri()) {
      setAgent('opencode')
      return
    }
    void getDaemonLocalAgent()
      .then((a) => {
        if (alive) setAgent(a)
      })
      .catch(() => {
        if (alive) setAgent('opencode')
      })
    return () => {
      alive = false
    }
  }, [])

  // Until the runtime is known, render nothing to avoid flashing the wrong pane.
  if (agent === null) return null
  if (agent === 'pi') return <PiLLMSection />
  if (agent === 'cursor') return <CursorLLMSection />
  if (agent === 'claude-code') return <ClaudeLLMSection />
  return <OpenCodeLLMSection />
}
