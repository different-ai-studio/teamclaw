// services/fc/test/sync-versions-query.test.mjs
//
// Regression test for the GET /sync/versions query-string parsing.
//
// Bug: the FC entrypoint built the request body from `event.rawQueryString`
// only, but the Alibaba Cloud FC HTTP trigger delivers query params in
// `event.queryStringParameters` (FC 2.0) / `event.queryParameters` (FC 3.0).
// That dropped teamId & path and 400'd version-history requests with
// "teamId is required". This pins the contract that syncGetQueryToBody() reads
// those fields (with rawQueryString / rawPath fallbacks).
//
// Pure function — no Supabase / network required.
//
// Run: node --test test/sync-versions-query.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncGetQueryToBody } from '../src/index.js';

test('reads teamId & path from queryStringParameters (FC 2.0)', () => {
  const body: any = syncGetQueryToBody({
    queryStringParameters: { teamId: 'team-123', path: 'knowledge/托尔斯泰.md', cursor: '10' },
  });
  assert.equal(body.teamId, 'team-123');
  assert.equal(body.path, 'knowledge/托尔斯泰.md');
  assert.equal(body.cursor, '10');
});

test('reads teamId & path from queryParameters (FC 3.0)', () => {
  const body: any = syncGetQueryToBody({
    queryParameters: { teamId: 'team-456', path: 'a/b.md' },
  });
  assert.equal(body.teamId, 'team-456');
  assert.equal(body.path, 'a/b.md');
});

test('falls back to rawQueryString when no structured params', () => {
  const body: any = syncGetQueryToBody({
    rawQueryString: 'teamId=team-789&path=c.md',
  });
  assert.equal(body.teamId, 'team-789');
  assert.equal(body.path, 'c.md');
});

test('falls back to a query string embedded in rawPath', () => {
  const body: any = syncGetQueryToBody({
    rawPath: '/sync/versions?teamId=team-abc&path=d.md',
  });
  assert.equal(body.teamId, 'team-abc');
  assert.equal(body.path, 'd.md');
});

test('empty event yields an empty body (handler then 400s "teamId is required")', () => {
  assert.deepEqual(syncGetQueryToBody({}), {});
});

test('reads teamId from queryParameters when queryStringParameters is empty (FC 3.0)', () => {
  const body: any = syncGetQueryToBody({
    queryStringParameters: {},
    queryParameters: { teamId: 'team-fc3', path: 'notes.md' },
  });
  assert.equal(body.teamId, 'team-fc3');
  assert.equal(body.path, 'notes.md');
});
