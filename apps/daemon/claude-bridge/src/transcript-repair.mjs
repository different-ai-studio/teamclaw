/**
 * Repair a session transcript the SDK can no longer send.
 *
 * The Agent SDK owns the conversation: we call `query({ resume })` and it
 * replays its own JSONL transcript. That makes any invalid record permanent —
 * every later turn re-sends it, the API rejects the request before the model
 * runs, and the session is bricked. The user sees only
 *
 *     API Error: 400 … messages.17.content.1: tool_use ids must be unique
 *
 * and every retry adds another copy of that error to the thread.
 *
 * The way in that we have actually observed: interrupting a tool call. The
 * transcript ends up with the interrupted tool's result recorded twice, either
 * side of the `[Request interrupted by user for tool use]` marker —
 *
 *     user  [ tool_result toolu_X, text "[Request interrupted…]", tool_result toolu_X ]
 *
 * The API merges consecutive same-role records into one message, so two
 * `tool_result`s that were written as separate records still land in one
 * `content` array, and the duplicate id is rejected.
 *
 * So: before resuming, drop the second and later blocks that reuse a tool id
 * inside the same merged message. Nothing else is touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The block types that carry a tool id, and where that id lives. */
function toolId(block) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'tool_use') return typeof block.id === 'string' ? block.id : null
  if (block.type === 'tool_result') {
    return typeof block.tool_use_id === 'string' ? block.tool_use_id : null
  }
  return null
}

function role(record) {
  const fromMessage = record?.message?.role
  if (typeof fromMessage === 'string') return fromMessage
  return typeof record?.type === 'string' ? record.type : null
}

/** Only user/assistant records become API messages; the rest are bookkeeping. */
function isMessageRecord(record) {
  const r = role(record)
  return (r === 'user' || r === 'assistant') && Array.isArray(record?.message?.content)
}

/**
 * Walk the records the way the API will: consecutive same-role message records
 * merge into one message, and a tool id may appear once per merged message.
 *
 * Deliberately per-message rather than per-transcript. Duplication *within* one
 * message is the shape we have seen and the one the API named; dropping a block
 * because its id appeared in some much earlier message would be a guess, and a
 * wrong guess here silently rewrites someone's conversation.
 *
 * @returns {{records: any[], removed: {index: number, blockIndex: number, id: string, type: string}[]}}
 */
export function repairRecords(records) {
  const out = []
  const removed = []
  /** Tool ids already used by the merged message currently being built. */
  let seen = new Set()
  let previousRole = null

  for (const [index, record] of records.entries()) {
    if (!isMessageRecord(record)) {
      // A non-message record (queue-operation, summary, …) does not break the
      // API's run of same-role messages: the two halves still merge.
      out.push(record)
      continue
    }

    const currentRole = role(record)
    if (currentRole !== previousRole) seen = new Set()
    previousRole = currentRole

    const kept = []
    for (const [blockIndex, block] of record.message.content.entries()) {
      const id = toolId(block)
      if (id === null) {
        kept.push(block)
        continue
      }
      if (seen.has(id)) {
        removed.push({ index, blockIndex, id, type: block.type })
        continue
      }
      seen.add(id)
      kept.push(block)
    }

    if (kept.length === record.message.content.length) {
      out.push(record)
      continue
    }
    if (kept.length === 0) {
      // Everything in it was a duplicate. An empty `content` is itself invalid,
      // so the record goes rather than becoming a new way to fail.
      continue
    }
    out.push({ ...record, message: { ...record.message, content: kept } })
  }

  return { records: out, removed }
}

/** Where the SDK keeps transcripts. `CLAUDE_CONFIG_DIR` wins when set. */
export function transcriptRoot(env = process.env, homedir = os.homedir()) {
  const configured = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()
  return path.join(configured || path.join(homedir, '.claude'), 'projects')
}

/**
 * Find `<root>/<some project dir>/<sessionId>.jsonl`.
 *
 * By id rather than by deriving the project directory from `cwd`: that name is
 * the SDK's own slug of the working directory, and re-implementing a slug rule
 * we do not own is a bug waiting for the day upstream changes it. Session ids
 * are uuids, so a filename match is unambiguous.
 */
export function findTranscript(sessionId, root = transcriptRoot()) {
  if (!sessionId || typeof sessionId !== 'string') return null
  const file = `${sessionId}.jsonl`
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = path.join(root, dir.name, file)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function parse(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A half-written last line is normal for an append-only log. Keeping the
      // raw text preserves it verbatim on rewrite.
      records.push({ __raw: line })
    }
  }
  return records
}

function serialize(records) {
  return records
    .map((r) => (r && typeof r === 'object' && '__raw' in r ? r.__raw : JSON.stringify(r)))
    .join('\n')
    .concat('\n')
}

/**
 * Repair the transcript for `sessionId` in place, if it needs it.
 *
 * Returns what was done so the caller can report it. A missing file, an
 * unreadable one, or a clean one are all "nothing to do" rather than errors:
 * this runs on the resume path and must never be the reason a session fails to
 * start.
 *
 * @returns {{repaired: boolean, path?: string, backup?: string, removed?: any[], error?: string}}
 */
export function repairTranscript(sessionId, root = transcriptRoot()) {
  const file = findTranscript(sessionId, root)
  if (!file) return { repaired: false }

  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { repaired: false, error: String(err?.message ?? err) }
  }

  const records = parse(text)
  const { records: fixed, removed } = repairRecords(records)
  if (removed.length === 0) return { repaired: false, path: file }

  // The conversation is the user's, and this rewrite is not something they
  // asked for — keep the original next to it.
  const backup = `${file}.bak-${Date.now()}`
  const tmp = `${file}.repair-${process.pid}`
  try {
    fs.copyFileSync(file, backup)
    fs.writeFileSync(tmp, serialize(fixed))
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best effort */
    }
    return { repaired: false, path: file, error: String(err?.message ?? err) }
  }
  return { repaired: true, path: file, backup, removed }
}
