import { Platform } from "react-native";

/**
 * Hai 灰 ("cooled ash") visual tokens, ported 1:1 from
 * `apps/ios/Packages/AMUXSharedUI/.../AMUXTheme.swift`. Six paper/ink
 * neutrals plus a single restrained cinnabar accent — "spare the
 * vermillion". Use these directly via `colors.<name>`; the legacy
 * semantic aliases below (`background`, `paper`, `foreground`, …) point
 * at the same values so screens that still use the old vocabulary keep
 * rendering with the new tones.
 */
export const hai = {
  mist: "#F2F0EC",
  paper: "#F8F6F1",
  pebble: "#E2DFD9",
  slate: "#A6A39C",
  basalt: "#5E5B55",
  onyx: "#22201D",
  cinnabar: "#B84B36",
  cinnabarDeep: "#8E3A2C",
  sage: "#6B8E5A",
  hairline: "rgba(34,32,29,0.10)",
  hairlineStrong: "rgba(34,32,29,0.16)",
} as const;

// Android: `"Inter"` would be ideal but we don't bundle it via expo-font yet,
// and asking Android for an unknown family + an explicit fontWeight can cause
// some devices to render nothing at all (notably visible on the Sessions list,
// where every row uses typography.body). Fall back to the Android system
// sans-serif (Roboto) until we ship Inter as an asset.
const sansFontFamily = Platform.select({
  android: "sans-serif",
  ios: "PingFang SC",
  web: '"Inter", "PingFang SC", "Noto Sans SC", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  default: "System",
});

/**
 * Headline / display face. iOS uses `Font.system(design: .serif)`
 * (New York) at the call sites; the Android system equivalent is Noto
 * Serif, which reads close enough to keep the wabi-sabi voice without
 * shipping EB Garamond as an asset. We can swap to expo-font later if
 * iOS ships the Garamond bundle first.
 */
const serifFontFamily = Platform.select({
  android: "serif",
  ios: "Times New Roman",
  web: '"EB Garamond", "Source Han Serif SC", Georgia, "Times New Roman", serif',
  default: "serif",
});

const monoFontFamily = Platform.select({
  android: "monospace",
  ios: "Menlo",
  web: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
  default: "monospace",
});

export const colors = {
  // Hai palette (canonical)
  mist: hai.mist,
  paper: hai.paper,
  pebble: hai.pebble,
  slate: hai.slate,
  basalt: hai.basalt,
  onyx: hai.onyx,
  cinnabar: hai.cinnabar,
  cinnabarDeep: hai.cinnabarDeep,
  sage: hai.sage,
  hairline: hai.hairline,
  hairlineStrong: hai.hairlineStrong,

  // Semantic aliases — back-compat for screens written before the Hai port.
  background: hai.mist,
  panel: hai.pebble,
  selected: "#D9D5CD",
  foreground: hai.onyx,
  ink: hai.onyx,
  ink2: hai.basalt,
  mutedForeground: hai.basalt,
  faint: hai.slate,
  border: hai.hairline,
  borderSoft: "rgba(34,32,29,0.06)",
  coral: hai.cinnabar,
  coralSoft: "rgba(184,75,54,0.16)",
  success: hai.sage,
  danger: hai.cinnabarDeep,
} as const;

export const typography = {
  sans: { fontFamily: sansFontFamily },
  serif: { fontFamily: serifFontFamily },
  mono: { fontFamily: monoFontFamily },

  display: {
    fontFamily: serifFontFamily,
    fontSize: 44,
    fontWeight: "400" as const,
    lineHeight: 48,
    letterSpacing: -0.5,
  },
  title: {
    fontFamily: serifFontFamily,
    fontSize: 28,
    fontWeight: "400" as const,
    lineHeight: 32,
    letterSpacing: -0.4,
  },
  sectionTitle: {
    fontFamily: sansFontFamily,
    fontSize: 15,
    fontWeight: "600" as const,
    lineHeight: 20,
  },
  body: {
    fontFamily: sansFontFamily,
    fontSize: 14,
    fontWeight: "400" as const,
    lineHeight: 21,
  },
  cardTitle: {
    fontFamily: sansFontFamily,
    fontSize: 13,
    fontWeight: "600" as const,
    lineHeight: 18,
  },
  secondaryBody: {
    fontFamily: sansFontFamily,
    fontSize: 12.5,
    fontWeight: "400" as const,
    lineHeight: 18,
  },
  meta: {
    fontFamily: sansFontFamily,
    fontSize: 12,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  caption: {
    fontFamily: sansFontFamily,
    fontSize: 11.5,
    fontWeight: "400" as const,
    lineHeight: 15,
  },
  monoMeta: {
    fontFamily: monoFontFamily,
    fontSize: 11,
    fontWeight: "500" as const,
    lineHeight: 14,
  },
  // Pill / eyebrow — mono, uppercase, wide tracking. Matches the
  // iOS spec: "JetBrains Mono ~10–11px, letter-spacing 0.18em–0.32em,
  // text-transform: uppercase for labels."
  pill: {
    fontFamily: monoFontFamily,
    fontSize: 10,
    fontWeight: "600" as const,
    lineHeight: 12,
    letterSpacing: 1.8,
    textTransform: "uppercase" as const,
  },
  eyebrow: {
    fontFamily: monoFontFamily,
    fontSize: 10.5,
    fontWeight: "500" as const,
    lineHeight: 14,
    letterSpacing: 2.8,
    textTransform: "uppercase" as const,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radii = {
  // Hai prefers quieter corners: 2–6px on cards/chips, 99px for dots/pills.
  none: 0,
  hairline: 2,
  chip: 4,
  card: 6,
  cardCompact: 6,
  button: 8,
  input: 10,
  panel: 14,
  pill: 999,
} as const;

export const shadows = {
  composer: {
    shadowColor: hai.onyx,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 2,
  },
  card: {
    shadowColor: hai.onyx,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
  // Hai-correct: avatar ring instead of drop shadow. Kept for completeness.
  avatarRing: {
    shadowColor: hai.paper,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 0,
  },
} as const;

export const dotSize = {
  status: 8,
  unread: 7,
  avatar: 22,
  avatarRingWidth: 1.5,
} as const;

export const theme = {
  colors,
  fontFamilies: {
    sans: sansFontFamily,
    serif: serifFontFamily,
    mono: monoFontFamily,
  },
  typography,
  spacing,
  radii,
  shadows,
  dotSize,
} as const;

export type AppTheme = typeof theme;
