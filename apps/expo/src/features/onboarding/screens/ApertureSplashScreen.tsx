import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { colors, iosType, spacing } from "../../../ui/theme";
import {
  APERTURE,
  APERTURE_COLORS,
  APERTURE_LAP_MS,
  APERTURE_START_DELAY_MS,
  apertureArcPath,
  apertureDotRotation,
} from "../aperture-geometry";

/**
 * Splash shown while bootstrap runs, ported from the iOS `ApertureSplashView`.
 *
 * Draws the TeamClu mark — a ring broken at the upper right with a coral dot
 * resting in the notch — and animates it once: the dot leaves the notch,
 * travels one lap of the ring, and settles back into it.
 *
 * The ring itself never changes. The brand kit also describes a completion
 * state where the ring closes behind the returning dot; that is deliberately
 * not implemented, because the splash reads better as a mark that stays itself
 * while something loads behind it.
 *
 * Vector, not a sliced PNG: a dot travelling a ring cannot be expressed by
 * pre-sliced images at all, and drawing it keeps the mark sharp at any size.
 */

export type ApertureSplashScreenProps = {
  size?: number;
  /**
   * Called once the dot has completed its lap and settled back in the notch.
   * Callers that would otherwise tear the splash down the instant their work
   * finishes use this to let the animation actually play — bootstrap can
   * complete in well under a lap.
   */
  onLapFinished?: () => void;
};

export function ApertureSplashScreen({
  size = 240,
  onLapFinished,
}: ApertureSplashScreenProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      onLapFinished?.();
    };

    // Reduce Motion: the mark holds at rest in the notch, and the caller is
    // released immediately rather than being made to wait out an animation
    // that isn't playing.
    if (reduceMotion) {
      finish();
      return;
    }

    const timer = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 1,
        duration: APERTURE_LAP_MS,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) finish();
      });
    }, APERTURE_START_DELAY_MS);

    return () => clearTimeout(timer);
  }, [onLapFinished, progress, reduceMotion]);

  const scale = size / APERTURE.viewBox;
  const dotDiameter = APERTURE.dotRadius * 2 * scale;
  const rotation = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [`${apertureDotRotation(0)}deg`, `${apertureDotRotation(1)}deg`],
  });

  return (
    <View style={styles.screen}>
      <View style={styles.stack}>
        <View style={[styles.mark, { height: size, width: size }]}>
          <Svg height={size} viewBox={`0 0 ${APERTURE.viewBox} ${APERTURE.viewBox}`} width={size}>
            <Path
              d={apertureArcPath()}
              fill="none"
              stroke={APERTURE_COLORS.ink}
              strokeLinecap="round"
              strokeWidth={APERTURE.strokeWidth}
            />
          </Svg>

          {/* The dot rides the ring line: parked at 12 o'clock, then rotated,
              so a single rotation drives the whole lap. */}
          <Animated.View
            style={[StyleSheet.absoluteFill, { transform: [{ rotate: rotation }] }]}
          >
            <View
              style={[
                styles.dot,
                {
                  borderRadius: dotDiameter / 2,
                  height: dotDiameter,
                  left: size / 2 - dotDiameter / 2,
                  top: size / 2 - APERTURE.ringRadius * scale - dotDiameter / 2,
                  width: dotDiameter,
                },
              ]}
            />
          </Animated.View>
        </View>

        <View style={styles.caption}>
          <Text style={styles.title}>Setting up TeamClu</Text>
          {/* Carries the "still working" signal once the dot has parked, so a
              slow bootstrap never looks frozen. */}
          <WorkingDots active={!reduceMotion} />
        </View>
      </View>
    </View>
  );
}

/** Three dots pulsing in sequence — the RN stand-in for iOS's variableColor. */
function WorkingDots({ active }: { active: boolean }) {
  const values = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    if (!active) return;
    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 180),
          Animated.timing(value, { toValue: 1, duration: 360, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0.3, duration: 360, useNativeDriver: true }),
          Animated.delay((values.length - 1 - index) * 180),
        ]),
      ),
    );
    for (const loop of loops) loop.start();
    return () => {
      for (const loop of loops) loop.stop();
    };
  }, [active, values]);

  return (
    <View style={styles.workingDots}>
      {values.map((value, index) => (
        <Animated.View key={index} style={[styles.workingDot, { opacity: value }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    alignItems: "center",
    gap: spacing.md,
  },
  dot: {
    backgroundColor: APERTURE_COLORS.coral,
    position: "absolute",
  },
  mark: {
    alignItems: "center",
    justifyContent: "center",
  },
  screen: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flex: 1,
    justifyContent: "center",
  },
  stack: {
    alignItems: "center",
    gap: 28,
  },
  title: {
    color: colors.onyx,
    ...iosType.headline,
  },
  workingDot: {
    backgroundColor: colors.slate,
    borderRadius: 2.5,
    height: 5,
    width: 5,
  },
  workingDots: {
    flexDirection: "row",
    gap: 5,
  },
});

export default ApertureSplashScreen;
