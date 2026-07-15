import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateDisplayName,
  DISPLAY_NAME_ADJECTIVES,
  DISPLAY_NAME_ANIMALS,
} from "../src/lib/display-name.js";

test("generateDisplayName: seeded result is deterministic and well-formed", () => {
  const seed = "11111111-2222-3333-4444-555555555555";
  const a = generateDisplayName(seed);
  const b = generateDisplayName(seed);
  assert.equal(a, b, "same seed must yield same name");

  const [adj, animal] = a.split(" ");
  assert.ok((DISPLAY_NAME_ADJECTIVES as readonly string[]).includes(adj), `unexpected adjective: ${adj}`);
  assert.ok((DISPLAY_NAME_ANIMALS as readonly string[]).includes(animal), `unexpected animal: ${animal}`);
});

test("generateDisplayName: different seeds generally differ", () => {
  const names = new Set(
    Array.from({ length: 50 }, (_, i) => generateDisplayName(`seed-${i}`)),
  );
  // 20x20 = 400 combos; 50 distinct seeds should produce plenty of variety.
  assert.ok(names.size > 20, `expected variety, got ${names.size} distinct names`);
});

test("generateDisplayName: never returns the literal 'You'", () => {
  for (let i = 0; i < 100; i++) {
    assert.notEqual(generateDisplayName(`seed-${i}`), "You");
  }
});

test("generateDisplayName: no seed still yields a valid Adjective Animal", () => {
  const [adj, animal] = generateDisplayName().split(" ");
  assert.ok((DISPLAY_NAME_ADJECTIVES as readonly string[]).includes(adj));
  assert.ok((DISPLAY_NAME_ANIMALS as readonly string[]).includes(animal));
});
