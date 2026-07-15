import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const deckPath = path.resolve(
  __dirname,
  "../docs/presentations/teamclaw-engineering-pilot-deck.html",
);

assert.ok(
  existsSync(deckPath),
  `Expected presentation HTML to exist at ${deckPath}`,
);

const html = readFileSync(deckPath, "utf8");

assert.match(html, /<title>Copilot 361 Engineering Pilot Deck<\/title>/);

const slideCount = (html.match(/class="slide(?: [^"]*)?"/g) || []).length;
assert.equal(slideCount, 9, `Expected 9 slides, found ${slideCount}`);

assert.match(html, /Copilot 361/);
assert.match(html, /Architecture Diagram/);
assert.match(html, /Why Start a Pilot Now/);
assert.match(html, /join the internal pilot/i);

console.log("Presentation verification passed.");
