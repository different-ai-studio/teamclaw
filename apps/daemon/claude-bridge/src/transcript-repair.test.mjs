import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  findTranscript,
  repairRecords,
  repairTranscript,
  transcriptRoot,
} from './transcript-repair.mjs'

const user = (...content) => ({ type: 'user', message: { role: 'user', content } })
const assistant = (...content) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
})
const text = (t) => ({ type: 'text', text: t })
const toolUse = (id) => ({ type: 'tool_use', id, name: 'Bash', input: {} })
const toolResult = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

test('the interrupted-tool shape: one tool_result survives, the repeat goes', () => {
  // Exactly what a real bricked session looked like: the tool's result written
  // once before the interrupt marker and once after, in separate records that
  // the API merges into a single user message.
  const records = [
    assistant(toolUse('toolu_A')),
    user(toolResult('toolu_A')),
    user(text('[Request interrupted by user for tool use]')),
    { type: 'queue-operation' },
    user(toolResult('toolu_A')),
  ]

  const { records: fixed, removed } = repairRecords(records)

  assert.equal(removed.length, 1)
  assert.equal(removed[0].id, 'toolu_A')
  assert.equal(removed[0].type, 'tool_result')
  // The record whose only block was the duplicate is gone; an empty content
  // array would just be a different 400.
  assert.equal(fixed.length, 4)
  assert.deepEqual(
    fixed.map((r) => r.type),
    ['assistant', 'user', 'user', 'queue-operation'],
  )
})

test('a bookkeeping record between two halves does not end the merge run', () => {
  const records = [
    user(toolResult('toolu_A')),
    { type: 'queue-operation' },
    user(toolResult('toolu_A')),
  ]
  const { removed } = repairRecords(records)
  assert.equal(removed.length, 1, 'the API merges across it, so we must too')
})

test('the same id in messages of different roles is left alone', () => {
  // tool_use and its tool_result share an id by design.
  const records = [assistant(toolUse('toolu_A')), user(toolResult('toolu_A'))]
  const { records: fixed, removed } = repairRecords(records)
  assert.deepEqual(removed, [])
  assert.deepEqual(fixed, records)
})

test('a role change resets the run, so a later reuse is not touched', () => {
  const records = [
    user(toolResult('toolu_A')),
    assistant(text('thinking')),
    user(toolResult('toolu_A')),
  ]
  const { removed } = repairRecords(records)
  assert.deepEqual(removed, [], 'only duplication inside one merged message is provably invalid')
})

test('a clean transcript comes back byte-identical', () => {
  const records = [
    user(text('hello')),
    assistant(text('hi'), toolUse('toolu_A'), toolUse('toolu_B')),
    user(toolResult('toolu_A'), toolResult('toolu_B')),
  ]
  const { records: fixed, removed } = repairRecords(records)
  assert.deepEqual(removed, [])
  assert.deepEqual(fixed, records)
})

test('two duplicates in one literal content array both go', () => {
  const records = [user(toolResult('toolu_A'), text('note'), toolResult('toolu_A'))]
  const { records: fixed, removed } = repairRecords(records)
  assert.equal(removed.length, 1)
  assert.deepEqual(
    fixed[0].message.content.map((b) => b.type),
    ['tool_result', 'text'],
  )
})

test('transcriptRoot honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(
    transcriptRoot({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }, '/home/x'),
    path.join('/tmp/cfg', 'projects'),
  )
  assert.equal(transcriptRoot({}, '/home/x'), path.join('/home/x', '.claude', 'projects'))
})

test('findTranscript locates the file by session id, whatever the project dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'))
  const dir = path.join(root, '-Users-someone-a-project')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'abc-123.jsonl')
  fs.writeFileSync(file, '')
  assert.equal(findTranscript('abc-123', root), file)
  assert.equal(findTranscript('nope', root), null)
})

test('repairTranscript rewrites in place and keeps the original', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'))
  const dir = path.join(root, 'proj')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sess.jsonl')
  const records = [
    assistant(toolUse('toolu_A')),
    user(toolResult('toolu_A')),
    user(text('[Request interrupted by user for tool use]')),
    user(toolResult('toolu_A')),
  ]
  const original = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(file, original)

  const result = repairTranscript('sess', root)

  assert.equal(result.repaired, true)
  assert.equal(result.removed.length, 1)
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original, 'the original is recoverable')
  const after = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const ids = after.flatMap((r) =>
    (r.message?.content ?? []).map((b) => b.tool_use_id ?? b.id).filter(Boolean),
  )
  assert.deepEqual(ids, ['toolu_A', 'toolu_A'], 'one tool_use + one tool_result remain')
})

test('a clean transcript is not rewritten at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'))
  const dir = path.join(root, 'proj')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sess.jsonl')
  fs.writeFileSync(file, JSON.stringify(user(text('hi'))) + '\n')
  const before = fs.statSync(file).mtimeMs

  const result = repairTranscript('sess', root)

  assert.equal(result.repaired, false)
  assert.equal(fs.statSync(file).mtimeMs, before, 'untouched')
  assert.deepEqual(fs.readdirSync(dir), ['sess.jsonl'], 'no backup litter')
})

test('a missing transcript is not an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'))
  assert.deepEqual(repairTranscript('absent', root), { repaired: false })
})

test('a half-written trailing line is preserved verbatim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'))
  const dir = path.join(root, 'proj')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sess.jsonl')
  const partial = '{"type":"user","message":{"role":"user","content":[{"type":"tex'
  fs.writeFileSync(
    file,
    [JSON.stringify(user(toolResult('toolu_A'))), JSON.stringify(user(toolResult('toolu_A'))), partial].join('\n') +
      '\n',
  )

  const result = repairTranscript('sess', root)

  assert.equal(result.repaired, true)
  assert.ok(fs.readFileSync(file, 'utf8').includes(partial), 'the torn line survives the rewrite')
})
