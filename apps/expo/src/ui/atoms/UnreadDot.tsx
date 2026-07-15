import { StyleSheet, View, type ViewStyle } from "react-native";

import { colors, dotSize } from "../theme";

export type UnreadDotProps = {
  hidden?: boolean;
  size?: number;
  style?: ViewStyle;
};

/**
 * 7px cinnabar dot at the row's trailing edge. Used to mark unread state
 * — never a count badge, per the Hai spec ("朱を惜しむ — spare the
 * vermillion").
 */
export function UnreadDot({ hidden = false, size = dotSize.unread, style }: UnreadDotProps) {
  if (hidden) return null;
  return (
    <View
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2 },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    backgroundColor: colors.cinnabar,
  },
});
