// services/fc/test/apns-jwt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApnsJwtCache } from '../src/lib/apns-jwt.js';

// ES256 dev key for tests only — DO NOT use in production.
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

test('createApnsJwtCache returns the same token until expiry', async () => {
  const cache = createApnsJwtCache({
    privateKeyP8: TEST_P8,
    keyId: 'ABCD1234EF',
    teamId: 'TEAM123456',
    nowMs: () => 1_700_000_000_000,
  });
  const t1 = await cache.get();
  const t2 = await cache.get();
  assert.equal(t1, t2, 'within window → same token');
});

test('createApnsJwtCache refreshes after 50 min', async () => {
  let now = 1_700_000_000_000;
  const cache = createApnsJwtCache({
    privateKeyP8: TEST_P8,
    keyId: 'ABCD1234EF',
    teamId: 'TEAM123456',
    nowMs: () => now,
  });
  const t1 = await cache.get();
  now += 51 * 60 * 1000;
  const t2 = await cache.get();
  assert.notEqual(t1, t2, 'after 50min → fresh token');
});
