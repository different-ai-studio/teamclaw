import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const deckPath = path.resolve(
  __dirname,
  "../docs/presentations/copilot-361-technical-principles-deck.html",
);

assert.ok(
  existsSync(deckPath),
  `Expected technical presentation HTML to exist at ${deckPath}`,
);

const html = readFileSync(deckPath, "utf8");

assert.match(html, /<title>Copilot 361 Technical Principles Deck<\/title>/);

const slideCount = (html.match(/class="slide(?: [^"]*)?"/g) || []).length;
assert.equal(slideCount, 9, `Expected 9 slides, found ${slideCount}`);

assert.match(html, /Design Principles/);
assert.match(html, /Request Lifecycle/);
assert.match(html, /Execution Boundaries/);
assert.match(html, /technical version/i);

console.log("Technical presentation verification passed.");
