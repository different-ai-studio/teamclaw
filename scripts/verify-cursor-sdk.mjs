#!/usr/bin/env node
/**
 * Smoke test for Cursor SDK feasibility (Composer local agent).
 * Usage: CURSOR_API_KEY=crsr_... node scripts/verify-cursor-sdk.mjs
 *
 * Run from apps/daemon/cursor-bridge after `npm install`, or set NODE_PATH.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bridgeDir = join(here, '../apps/daemon/cursor-bridge')
const require = createRequire(join(bridgeDir, 'package.json'))
const { Agent, Cursor, CursorAgentError } = require('@cursor/sdk')

const apiKey = process.env.CURSOR_API_KEY?.trim()
if (!apiKey) {
  console.error('Missing CURSOR_API_KEY')
  process.exit(1)
}

const cwd = process.env.CURSOR_SDK_CWD || process.cwd()

async function main() {
  console.log('=== 1. List models ===')
  const models = await Cursor.models.list({ apiKey })
  const ids = models.map((m) => m.id)
  console.log('count:', ids.length)
  console.log('ids:', ids.slice(0, 20).join(', '), ids.length > 20 ? '...' : '')

  const modelId = ids.includes('composer-2.5') ? 'composer-2.5' : ids[0]
  if (!modelId) {
    console.error('No models returned for this key')
    process.exit(1)
  }
  console.log('using model:', modelId)

  console.log('\n=== 2. Local agent prompt ===')
  console.log('cwd:', cwd)

  const agent = await Agent.create({
    apiKey,
    model: { id: modelId },
    local: { cwd, settingSources: [] },
  })

  try {
    console.log('agentId:', agent.agentId)

    const run = await agent.send('Reply with exactly one word: pong')
    let streamed = ''
    for await (const event of run.stream()) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            streamed += block.text
            process.stdout.write(block.text)
          }
        }
      }
    }
    console.log()

    const result = await run.wait()
    console.log('runId:', result.id)
    console.log('status:', result.status)
    console.log('streamed text:', JSON.stringify(streamed.trim()))

    if (result.status === 'error') {
      console.error('Run finished with error status')
      process.exit(2)
    }

    console.log('\n=== OK: Cursor SDK local agent works ===')
  } finally {
    await agent[Symbol.asyncDispose]?.()
  }
}

main().catch((err) => {
  if (err instanceof CursorAgentError) {
    console.error('CursorAgentError:', err.message, 'retryable=', err.isRetryable)
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
