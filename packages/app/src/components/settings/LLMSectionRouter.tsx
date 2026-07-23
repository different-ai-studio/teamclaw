import * as React from 'react'
import { getDaemonLocalAgent, type DaemonLocalAgent } from '@/lib/daemon-local-client'
import { isTauri } from '@/lib/utils'
import { OpenCodeLLMSection } from './LLMSection'
import { PiLLMSection } from './PiLLMSection'

/**
 * LLM settings dispatcher. The local agent runtime determines both the logic
 * and the layout: opencode configures providers via opencode.json / opencode
 * serve (connect, OAuth, custom providers); pi owns its own credentials on the
 * host (`pi /login`) and only exposes a read-only model catalog. We branch on
 * `agents.local_agent` so each runtime gets its own pane.
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
  return agent === 'pi' ? <PiLLMSection /> : <OpenCodeLLMSection />
}
