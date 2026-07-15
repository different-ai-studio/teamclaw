import { Ionicons } from "@expo/vector-icons";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";

import { hai } from "../../../ui/theme";

export type ImageLightboxProps = {
  onClose: () => void;
  url: string | null;
};

/**
 * Full-screen image viewer used when the user taps an image
 * attachment in the message feed. Mirrors iOS `ImageLightbox`: black
 * backdrop, dismiss on tap-anywhere, close affordance top-left. Heavy
 * pan/zoom can land later with `react-native-image-zoom-viewer`.
 */
export function ImageLightbox({ onClose, url }: ImageLightboxProps) {
  if (!url) return null;
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.backdrop}>
        <Image
          accessibilityRole="image"
          resizeMode="contain"
          source={{ uri: url }}
          style={styles.image}
        />
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={12}
          onPress={onClose}
          style={styles.closeButton}
        >
          <Ionicons color={hai.paper} name="close" size={24} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.92)",
    flex: 1,
    justifyContent: "center",
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    left: 16,
    position: "absolute",
    top: 48,
    width: 36,
  },
  image: {
    height: "100%",
    width: "100%",
  },
});

export default ImageLightbox;
