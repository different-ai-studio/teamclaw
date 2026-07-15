import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, dotSize, typography } from "../theme";

export type AvatarEntry = {
  id: string;
  initials: string;
  /** Background color override; defaults to a hash of initials. */
  bg?: string;
  fg?: string;
};

export type AvatarStackProps = {
  avatars: AvatarEntry[];
  /** Maximum number of visible avatars before the "+N" overflow chip. */
  max?: number;
  size?: number;
  style?: ViewStyle;
};

const STOCK_BG = [
  colors.basalt,
  colors.slate,
  colors.sage,
  colors.cinnabar,
  colors.onyx,
];

function pickBg(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return STOCK_BG[Math.abs(hash) % STOCK_BG.length] ?? colors.basalt;
}

/**
 * Overlapping circle stack — 22px circles, -6px overlap, 1.5px paper
 * ring (drawn via `borderColor: paper`, not a real shadow). Matches the
 * iOS "participant stack" component.
 */
export function AvatarStack({
  avatars,
  max = 3,
  size = dotSize.avatar,
  style,
}: AvatarStackProps) {
  const shown = avatars.slice(0, max);
  const overflow = avatars.length - shown.length;
  const radius = size / 2;

  return (
    <View style={[styles.row, style]}>
      {shown.map((entry, index) => (
        <View
          key={entry.id}
          style={[
            styles.cell,
            {
              backgroundColor: entry.bg ?? pickBg(entry.id),
              borderRadius: radius,
              height: size,
              marginLeft: index === 0 ? 0 : -6,
              width: size,
              zIndex: shown.length - index,
            },
          ]}
        >
          <Text style={[styles.initials, { color: entry.fg ?? colors.paper }]}>
            {entry.initials.slice(0, 2).toUpperCase()}
          </Text>
        </View>
      ))}
      {overflow > 0 ? (
        <View
          style={[
            styles.cell,
            styles.overflow,
            {
              borderRadius: radius,
              height: size,
              marginLeft: -6,
              width: size,
            },
          ]}
        >
          <Text style={[styles.initials, styles.overflowLabel]}>
            +{overflow}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: {
    alignItems: "center",
    // iOS spec uses a Mist ring (1.5pt) so the avatar stack reads as
    // overlapping chips against the Mist-tinted list background. Using
    // Paper here punched a near-white halo through the list.
    borderColor: colors.mist,
    borderWidth: dotSize.avatarRingWidth,
    justifyContent: "center",
  },
  initials: {
    ...typography.monoMeta,
    fontSize: 9.5,
    fontWeight: "600",
  },
  overflow: {
    backgroundColor: colors.pebble,
  },
  overflowLabel: {
    color: colors.basalt,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
  },
});
