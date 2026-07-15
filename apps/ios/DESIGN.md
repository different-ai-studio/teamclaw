# AMUX — Design System

AMUX is a SwiftUI/iOS client for a daemon where humans and AI coding agents share
sessions over MQTT. The visual language is **wabi-sabi**: weathered, quiet,
hand-mixed. Treat every addition as if it were ink on washi — restraint first.

## Ratified palette: Hai 灰 ("cooled ash")

Near-monochrome of pale stone, basalt, and ink. Coral is rationed almost entirely
to the active state. Reads as "studio software".

| Token       | Hex       | Role                                                  |
|-------------|-----------|-------------------------------------------------------|
| `mist`      | `#F2F0EC` | App background (paper)                                |
| `pebble`    | `#E2DFD9` | Cards, hairlines, divider fills, chip backgrounds     |
| `slate`     | `#A6A39C` | Secondary text, idle status, captions                 |
| `basalt`    | `#5E5B55` | Body text on light surfaces                           |
| `onyx`      | `#22201D` | Primary text, titles                                |
| `cinnabar`  | `#B84B36` | The Seal — accents, active dot, unread, primary verb  |

### Semantic / status colors (outside the palette)
- `active` green `#6B8E5A` — running session indicator (breathing animation)
- `error` `#8E3A2C` — desaturated, never bright red
- `idle / stopped` → `slate` `#A6A39C`

### Dark mode (Sumi 墨) — implemented
`#181513` night, `#25221E` lamp, `#3A352F` stone, `#7A7166` ash, `#E8E2D5` bone,
`#D86B53` ember. Coral becomes an ember, never a stop sign.

Every `Color.amux.*` token is adaptive (`AMUXTheme.adaptive(light:dark:)`, a
`UIColor`/`NSColor` dynamic provider), so the whole surface follows the system
appearance automatically — no per-view `@Environment(\.colorScheme)` branching.
Hai→Sumi mapping: `mist`→night, `paper`→lamp, `pebble`→stone, `slate`→ash,
`onyx`→bone, `cinnabar`→ember. Three values DESIGN didn't pin are derived:
`basalt`→`#CFC8BA` (a dimmed bone, one rung below the onyx→bone primary so the
text hierarchy survives inversion), `sage`→`#7FA06B` (lifted so the breathing
dot reads on the night ground), and `cinnabarDeep`→held at `#8E3A2C` (already a
desaturated, non-alarming red on both grounds). Hairline flips onyx@10% →
bone@10% so separators lift off the night instead of vanishing.

## Type

- **EB Garamond** — headlines, serif moments. Use italic (`<em>`) for emphasis;
  the italic should usually carry the `cinnabar` color. Tight tracking (`-0.5px`
  to `-1.5px`), line-height ~`1.0` at display sizes.
- **Inter** — UI body, 13–17px, `letter-spacing: -0.05` to `-0.1px`.
  System stack `-apple-system, system-ui` is acceptable inside iOS frames.
- **JetBrains Mono** — system identifiers, eyebrows, meta strings, hex codes.
  ~10–11px, `letter-spacing: 0.18em–0.32em`, `text-transform: uppercase` for
  labels. Never set mono in regular sentences.

Three fonts, no more. Loaded once in the host HTML from Google Fonts.

## Three principles (read aloud before adding anything)

1. **不足の美 — Beauty of insufficiency.** Leave space empty. A list of three
   things does not need a card around it. A status word does not need a pill.
   The blank is the design.
2. **朱を惜しむ — Spare the vermillion.** Coral is a seal, not a paint. Use it
   for the active session, the breathing dot, the one verb that matters.
   Anywhere else it cheapens.
3. **手の跡 — Trace of the hand.** Off-whites over true white. Hairlines
   (`0.5px solid rgba(31,27,23,0.08)`) over borders. Slight asymmetry. The
   interface should feel like it was made by someone, not stamped from a die.

## Surface & shape rules

- **Backgrounds** are always toned (`mist` / `pebble`); never `#fff` or `#000`.
- **Dividers** are hairlines: `0.5px solid rgba(31,27,23,0.08)` (the `--line`
  token). Avoid 1px borders on cards.
- **Corner radii**: 2–6px on cards and chips, 99px for dots/pills only.
  Avoid the 12–16px iOS-default look; we are quieter than that.
- **Shadows**: none, or `0 0 0 1.5px #fff` ring on avatars stacking.
- **Pills/tags** when used: `pebble` fill, `basalt` text, mono 9.5–10px, tracking
  `0.18em`, uppercase. Use sparingly — prefer raw text + dot.

## Component patterns (iOS client)

- **Status dot**: 8px circle in semantic color. The `active` green breathes via
  `@keyframes amuxBreathe` (1.4s ease-in-out infinite, opacity 1 → 0.45).
- **Unread**: 7px `cinnabar` dot at the row's trailing edge, never a count badge.
- **Agent badge**: 22px tall, 7px horizontal padding, 6px radius, agent's own
  fg/bg pair, contains a 5px status dot + monospace glyph (e.g. `CLAUDE`).
- **Participant stack**: 22px avatar circles, `-6px` overlap, `0 0 0 1.5px #fff`
  ring, mono initials.
- **Time stamps**: `rgba(60,60,67,0.5)`, 12px, trailing.
- **Eyebrows / section nums**: mono 10–11px, `0.28em–0.32em` tracking, `slate`
  at 60–70% opacity.

## Layout

- iOS artboards are **402 × 874** (iPhone 16). Hi-fi inside an `<IOSFrame>`.
- The full app is composed inside `<DesignCanvas>` from `design-canvas.jsx`,
  grouped by `<DCSection>` rows (Onboarding · Core flow · Collaboration ·
  Create sheets · Alerts).
- Every new screen lives in `screens/<name>.jsx`, exported to `window` at the
  bottom of the file, and registered as a `<script type="text/babel">` tag in
  `AMUX iOS Client.html`.

## What to avoid

- True black, true white, pure grays.
- Saturated reds, blues, greens. Coral is the only warm accent.
- Gradients, glassmorphism, glow, drop shadows.
- Emoji as iconography.
- Hand-drawn SVG illustration — use striped placeholders with a monospace
  caption describing the missing asset.
- Inter/Roboto-only typography. The Garamond italic is load-bearing — without
  it the system loses its voice.

## File map

- `AMUX iOS Client.html` — host file, mounts the design canvas.
- `AMUX Palettes.html` — the four-palette study (Shironeri, Sumi, Sabi, Hai).
  Hai is ratified; the others are reference.
- `design-canvas.jsx` — `<DesignCanvas>` / `<DCSection>` / `<DCArtboard>` shell.
- `ios-frame.jsx` — iPhone bezel + status bar + home indicator.
- `screens/` — one component per screen, mounted inside `<IOSFrame>`.
- `assets/lobster-logo.png` — the mark. Do not redraw.

---

## SwiftUI implementation notes

Where the spec above describes the design intent, this section captures how
it shows up in code so future edits stay aligned.

- **Tokens live in** `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/AMUXTheme.swift`,
  exposed via `Color.amux.{mist|pebble|slate|basalt|onyx|cinnabar|...}`. Don't
  hardcode hex in views.
- **Hai sheets** (pebble→mist background + paper cards) use the shared
  primitives in `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Shared/HaiSheet.swift`:
  `HaiSectionLabel`, `HaiSheetRow`, `HaiPaperCard`. See `IdeaSheet`,
  `NewSessionSheet`, `MemberListView` for canonical examples.
- **Toolbar buttons on iOS 26+**: the system already wraps each `ToolbarItem`
  button in a glass capsule. Do NOT add `.glassButtonStyle()`,
  `.glassProminentButtonStyle()`, or `.liquidGlass(...)` inside `.toolbar` —
  it stacks a second background. Use
  `Image + .font(.title3) + .foregroundStyle(...) + .buttonStyle(.plain)` and
  let the system wrap. Tint the primary verb with `Color.amux.cinnabar`,
  disabled state with `Color.amux.slate.opacity(0.5)`.
- **Body CTAs** (full-width primary buttons inside the body, not in a toolbar)
  are the right place for `.glassProminentButtonStyle()`.
