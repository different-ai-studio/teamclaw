import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { logSyncEvent } from '../src/lib/sync-log.js';

/**
 * Unit tests for logSyncEvent (spec §5.4.1).
 * Verifies that the emitted JSON line includes required fields.
 */
describe('logSyncEvent', () => {
  let captured = [];
  let originalLog;

  before(() => {
    originalLog = console.log;
    console.log = (...args) => captured.push(args[0]);
  });

  after(() => {
    console.log = originalLog;
  });

  it('emits valid JSON with ts field', () => {
    captured = [];
    logSyncEvent({ endpoint: '/sync/manifest', teamId: 'team-1', latencyMs: 42, result: 200 });
    assert.equal(captured.length, 1);
    const obj = JSON.parse(captured[0]);
    assert.ok(typeof obj.ts === 'string', 'ts must be a string');
    // ts should be a valid ISO 8601 date
    assert.ok(!isNaN(Date.parse(obj.ts)), 'ts must be a valid ISO 8601 date');
  });

  it('includes all provided fields in the output', () => {
    captured = [];
    logSyncEvent({
      endpoint: '/sync/upload/complete',
      teamId: 'team-abc',
      actorId: 'actor-uuid',
      latencyMs: 123,
      result: 200,
      changeSeq: 77,
      contentHash: 'abcdef1234',
      sizeBytes: 4096,
      errorCode: undefined,
    });
    const obj = JSON.parse(captured[0]);
    assert.equal(obj.endpoint, '/sync/upload/complete');
    assert.equal(obj.teamId, 'team-abc');
    assert.equal(obj.actorId, 'actor-uuid');
    assert.equal(obj.latencyMs, 123);
    assert.equal(obj.result, 200);
    assert.equal(obj.changeSeq, 77);
    assert.equal(obj.contentHash, 'abcdef1234');
    assert.equal(obj.sizeBytes, 4096);
  });

  it('includes errorCode when provided', () => {
    captured = [];
    logSyncEvent({
      endpoint: '/sync/manifest',
      teamId: 'team-xyz',
      latencyMs: 5,
      result: 'error',
      errorCode: 'P0403',
    });
    const obj = JSON.parse(captured[0]);
    assert.equal(obj.errorCode, 'P0403');
    assert.equal(obj.result, 'error');
  });

  it('produces a single line (no embedded newlines)', () => {
    captured = [];
    logSyncEvent({ endpoint: '/sync/delete', latencyMs: 10, result: 200 });
    assert.equal(captured.length, 1);
    assert.ok(!captured[0].includes('\n'), 'output must be a single line');
  });
});
