import { StyleSheet, View, type ViewStyle } from "react-native";

import { colors } from "../theme";

export type HairlineProps = {
  vertical?: boolean;
  inset?: number;
  style?: ViewStyle;
};

/**
 * 0.5px (or device-thin) onyx hairline at 10% opacity. The Hai system
 * forbids 1px borders on cards — these are the only acceptable divider.
 */
export function Hairline({ vertical = false, inset = 0, style }: HairlineProps) {
  return (
    <View
      style={[
        vertical ? styles.vertical : styles.horizontal,
        inset ? (vertical ? { marginVertical: inset } : { marginHorizontal: inset }) : null,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  horizontal: {
    backgroundColor: colors.hairline,
    height: StyleSheet.hairlineWidth,
    width: "100%",
  },
  vertical: {
    backgroundColor: colors.hairline,
    height: "100%",
    width: StyleSheet.hairlineWidth,
  },
});
