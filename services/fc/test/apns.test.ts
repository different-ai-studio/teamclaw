// services/fc/test/apns.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApnsClient } from '../src/lib/apns.js';

function fakeJwt() { return { async get() { return 'jwt-token'; } }; }

test('sends payload with correct headers', async () => {
  const calls = [];
  const transport = async ({ method, path, headers, body }) => {
    calls.push({ method, path, headers, body });
    return { status: 200, body: '' };
  };
  const apns = createApnsClient({
    jwt: fakeJwt(),
    topic: 'tech.teamclaw.app',
    transport,
  });
  await apns.send('TOKEN', { aps: { alert: { title: 't', body: 'b' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/3/device/TOKEN');
  assert.equal(calls[0].headers['apns-topic'], 'tech.teamclaw.app');
  assert.equal(calls[0].headers['authorization'], 'bearer jwt-token');
  assert.equal(calls[0].headers['apns-push-type'], 'alert');
});

test('returns status + reason on failure', async () => {
  const transport = async () => ({ status: 410, body: '{"reason":"Unregistered"}' });
  const apns = createApnsClient({ jwt: fakeJwt(), topic: 't', transport });
  const r = await apns.send('TOKEN', {});
  assert.equal(r.status, 410);
  assert.equal(r.reason, 'Unregistered');
});
