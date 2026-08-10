import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View, type ViewStyle } from "react-native";

import { colors } from "./theme";

/**
 * The nearest thing to iOS Liquid Glass that React Native can draw.
 *
 * iOS 26 renders bars with `glassEffect(.regular)`, which adds specular
 * highlights and edge refraction on top of a blur. Neither is reachable from
 * RN. What *is* reachable is the recipe iOS itself falls back to below 26
 * (`LiquidGlassBar.liquidGlass`): a tint at 14% over `.ultraThinMaterial`,
 * with a soft shadow. That fallback is the spec this implements.
 *
 * **Android draws no glass at all.** `expo-blur`'s only real backdrop blur
 * there is the experimental Dimezis path, and it misbehaved on device — which
 * is why the tab bar stopped using this component entirely. The remaining
 * consumer is `GlassHeader`, and it tints at 85%, so the blur underneath was
 * contributing almost nothing anyway: an opaque fill of the same colour is
 * within a rounding error of what the blur produced, minus the artefacts.
 *
 * Note the fallback is *opaque*, not "the translucent tint alone". A tint with
 * no blur behind it leaves content legible straight through the bar, which is
 * worse than either alternative — the tint's whole job is to hold a title
 * readable over whatever scrolls past.
 */

export type GlassSurfaceProps = {
  /** Tint laid over the blur. Defaults to the neutral iOS uses when untinted. */
  tint?: string;
  /** 0…1. iOS's fallback fills the shape at 14%. */
  tintOpacity?: number;
  intensity?: number;
  style?: ViewStyle;
};

/** `.ultraThinMaterial` sits around here on expo-blur's 0–100 scale. */
const DEFAULT_INTENSITY = 40;

export function GlassSurface({
  intensity = DEFAULT_INTENSITY,
  style,
  tint,
  tintOpacity = 0.14,
}: GlassSurfaceProps) {
  if (Platform.OS === "android") {
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.clip,
          { backgroundColor: tint ?? colors.mist },
          style,
        ]}
      />
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.clip, style]}>
      <BlurView intensity={intensity} style={StyleSheet.absoluteFill} tint="light" />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: tint ?? colors.slate, opacity: tintOpacity },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: "hidden",
  },
});

export default GlassSurface;
