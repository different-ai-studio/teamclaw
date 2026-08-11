import type { ReactNode } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "./theme";

export type SheetModalProps = {
  visible: boolean;
  onRequestClose: () => void;
  /** iOS presentation. Android renders every modal full-screen regardless. */
  presentationStyle?: "pageSheet" | "formSheet";
  children: ReactNode;
};

/**
 * Full-screen sheet presented over the app, with its own safe area.
 *
 * React Native's `Modal` renders into a separate native container, **outside**
 * the root `SafeAreaView` in `app/_layout.tsx`. Every sheet in this app assumed
 * that root inset existed, so each one's pinned header ran under the status
 * bar and became untappable — reported on Add Member, but all eight sheets had
 * it.
 *
 * Android is where it bites hardest: `pageSheet` is iOS-only, so a modal there
 * is always full-screen and always starts at y=0.
 *
 * The inset lives here rather than in each sheet so a new modal cannot forget
 * it. `useSafeAreaInsets` is used instead of a nested `SafeAreaView` because
 * the padding is then explicit and does not depend on how edge resolution
 * behaves across the modal's container boundary.
 */
export function SheetModal({
  visible,
  onRequestClose,
  presentationStyle = "pageSheet",
  children,
}: SheetModalProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      onRequestClose={onRequestClose}
      presentationStyle={presentationStyle}
      visible={visible}
    >
      <View
        style={[
          styles.container,
          { paddingBottom: insets.bottom, paddingTop: insets.top },
        ]}
      >
        {children}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.mist,
    flex: 1,
  },
});

export default SheetModal;
