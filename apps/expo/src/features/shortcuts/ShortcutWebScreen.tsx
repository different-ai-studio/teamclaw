// apps/expo/src/features/shortcuts/ShortcutWebScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { colors, spacing, typography } from "../../ui/theme";

export type ShortcutWebScreenProps = {
  url: string;
  title: string;
  onClose: () => void;
};

export function ShortcutWebScreen({ url, title, onClose }: ShortcutWebScreenProps) {
  const webviewRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [nav, setNav] = useState<WebViewNavigation>({
    canGoBack: false,
    canGoForward: false,
    loading: true,
    title: "",
    url,
    navigationType: "other",
    lockIdentifier: 0,
    target: "",
  } as WebViewNavigation);

  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!nav.loading) {
      phase.stopAnimation();
      phase.setValue(0);
      return;
    }
    Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ).start();
  }, [nav.loading, phase]);

  const host = (() => {
    try { return new URL(nav.url).host; } catch { return ""; }
  })();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.chrome}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={styles.closeButton}
        >
          <Ionicons color={colors.basalt} name="close" size={14} />
        </Pressable>

        <View style={styles.titleColumn}>
          <Text numberOfLines={1} style={styles.title}>
            {nav.title || title}
          </Text>
          <Text numberOfLines={1} style={styles.host}>
            {host || nav.url}
          </Text>
        </View>

        <ChromeButton enabled={nav.canGoBack} icon="chevron-back" onPress={() => webviewRef.current?.goBack()} />
        <ChromeButton enabled={nav.canGoForward} icon="chevron-forward" onPress={() => webviewRef.current?.goForward()} />
        <ChromeButton enabled icon="refresh" onPress={() => webviewRef.current?.reload()} />
        <ChromeButton
          enabled
          icon="share-outline"
          onPress={() => { void Share.share({ url: nav.url, message: nav.title || nav.url }); }}
        />
      </View>

      <View style={styles.loadingBarContainer}>
        {nav.loading ? (
          <Animated.View
            style={[
              styles.loadingBar,
              {
                transform: [{
                  translateX: phase.interpolate({ inputRange: [0, 1], outputRange: [-80, 360] }),
                }],
              },
            ]}
          />
        ) : null}
      </View>

      <WebView
        ref={webviewRef}
        source={{ uri: url }}
        onNavigationStateChange={setNav}
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={["*"]}
        startInLoadingState
        style={styles.webview}
      />
    </View>
  );
}

function ChromeButton({
  enabled, icon, onPress,
}: { enabled: boolean; icon: React.ComponentProps<typeof Ionicons>["name"]; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chromeButton, !enabled ? styles.chromeButtonDisabled : null, pressed ? styles.chromeButtonPressed : null]}
    >
      <Ionicons color={enabled ? colors.basalt : colors.slate} name={icon} size={14} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chrome: {
    alignItems: "center",
    backgroundColor: colors.paper,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chromeButton: {
    alignItems: "center",
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  chromeButtonDisabled: { opacity: 0.5 },
  chromeButtonPressed: { opacity: 0.6 },
  closeButton: {
    alignItems: "center",
    backgroundColor: colors.pebble,
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  host: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 11,
  },
  loadingBar: {
    backgroundColor: colors.cinnabar,
    height: 1.5,
    width: 80,
  },
  loadingBarContainer: {
    backgroundColor: colors.hairline,
    height: 1.5,
    overflow: "hidden",
  },
  screen: { backgroundColor: colors.paper, flex: 1 },
  title: {
    color: colors.onyx,
    fontSize: 14,
    fontWeight: "600",
  },
  titleColumn: { flex: 1, marginLeft: 6 },
  webview: { flex: 1 },
});
