// services/fc/test/push-filters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inDnd, isForegroundDevice, truncate } from '../src/lib/push-filters.js';

test('inDnd: disabled when start is null', () => {
  assert.equal(inDnd({ dnd_start_min: null }, new Date()), false);
});

test('inDnd: simple window 09:00-17:00 Shanghai', () => {
  const tz = 'Asia/Shanghai';
  // 2026-05-17 10:00 +08 → inside
  assert.equal(inDnd({ dnd_start_min: 540, dnd_end_min: 1020, dnd_tz: tz },
                     new Date('2026-05-17T02:00:00Z')), true);
  // 2026-05-17 18:00 +08 → outside
  assert.equal(inDnd({ dnd_start_min: 540, dnd_end_min: 1020, dnd_tz: tz },
                     new Date('2026-05-17T10:00:00Z')), false);
});

test('inDnd: cross-midnight window 22:00-07:00', () => {
  const tz = 'Asia/Shanghai';
  const prefs = { dnd_start_min: 1320, dnd_end_min: 420, dnd_tz: tz };
  // 23:30 → inside
  assert.equal(inDnd(prefs, new Date('2026-05-17T15:30:00Z')), true);
  // 06:30 next day → inside
  assert.equal(inDnd(prefs, new Date('2026-05-17T22:30:00Z')), true);
  // 12:00 → outside
  assert.equal(inDnd(prefs, new Date('2026-05-17T04:00:00Z')), false);
});

test('isForegroundDevice: presence with later until matches device', () => {
  const presence = [{ device_id: 'D1', foreground_until: '2099-01-01T00:00:00Z' }];
  assert.equal(isForegroundDevice(presence, 'D1'), true);
  assert.equal(isForegroundDevice(presence, 'D2'), false);
});

test('truncate: long string ellipsizes', () => {
  assert.equal(truncate('a'.repeat(100), 10), 'aaaaaaaaa…');
  assert.equal(truncate('short', 10), 'short');
});
