// apps/expo/app/(app)/shortcut-web.tsx
import { useLocalSearchParams, useRouter } from "expo-router";

import { ShortcutWebScreen } from "../../src/features/shortcuts/ShortcutWebScreen";

export default function ShortcutWebRoute() {
  const router = useRouter();
  const { url, title } = useLocalSearchParams<{ url?: string; title?: string }>();
  if (!url) {
    return null;
  }
  return (
    <ShortcutWebScreen
      url={url}
      title={title ?? ""}
      onClose={() => {
        if (router.canGoBack()) router.back();
        else router.replace("/(app)/(tabs)/sessions");
      }}
    />
  );
}
