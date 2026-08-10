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
 * Android caveat: `expo-blur` only does a real backdrop blur there via the
 * experimental Dimezis method. It is opt-in per platform below; where it is
 * unavailable the component degrades to the translucent tint alone, which is
 * still closer to the bar iOS draws than an opaque fill.
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
  return (
    <View style={[StyleSheet.absoluteFill, styles.clip, style]}>
      <BlurView
        // Real blur on Android needs the experimental path; iOS uses the
        // system material either way.
        experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
        intensity={intensity}
        style={StyleSheet.absoluteFill}
        tint="light"
      />
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
