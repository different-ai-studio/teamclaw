import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  bundledCloudApiUrl,
  getCloudApiUrlOverride,
  hasCloudApiUrlOverride,
  setCloudApiUrlOverride,
} from "../../../lib/cloud-api/cloud-api-url";
import { cloudApiBaseUrl } from "../../../lib/cloud-api/client";
import {
  normalizeServerEndpoint,
  probeServerEndpoint,
} from "../../../lib/cloud-api/server-endpoint";
import { Hairline } from "../../../ui/atoms/Hairline";
import { colors, radii, spacing, typography } from "../../../ui/theme";

export type ServerSettingsSheetProps = {
  onCancel: () => void;
  /** Called after a successful save (override already persisted). */
  onSaved: () => void | Promise<void>;
};

/**
 * Pre-auth server picker. Mirrors iOS `ServerSettingsSheet`: probe
 * `GET /v1/config/public`, persist the override, then hand control back so the
 * shell can rebuild the Cloud API stack — no relaunch required.
 */
export function ServerSettingsSheet({ onCancel, onSaved }: ServerSettingsSheetProps) {
  const { t } = useTranslation();
  const bundledDefault = bundledCloudApiUrl();
  const [urlText, setUrlText] = useState(() => {
    try {
      return cloudApiBaseUrl();
    } catch {
      return bundledDefault ?? "";
    }
  });
  const [isProbing, setIsProbing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOverridden, setIsOverridden] = useState(hasCloudApiUrlOverride);

  useEffect(() => {
    setIsOverridden(hasCloudApiUrlOverride());
  }, []);

  const save = async () => {
    setErrorMessage(null);
    const url = normalizeServerEndpoint(urlText);
    if (!url) {
      setErrorMessage(t("Enter a server address like https://api.example.com."));
      return;
    }
    setIsProbing(true);
    try {
      const outcome = await probeServerEndpoint(url);
      if (outcome.kind === "badStatus") {
        setErrorMessage(
          t(
            "That server answered with HTTP {{status}} — it doesn't look like a TeamClu Cloud API.",
            { status: outcome.status },
          ),
        );
        return;
      }
      if (outcome.kind === "unreachable") {
        setErrorMessage(t("Can't reach that server: {{reason}}", { reason: outcome.reason }));
        return;
      }
      await setCloudApiUrlOverride(url);
      setIsOverridden(hasCloudApiUrlOverride());
      await onSaved();
    } finally {
      setIsProbing(false);
    }
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("Cancel")}
          accessibilityRole="button"
          disabled={isProbing}
          hitSlop={8}
          onPress={onCancel}
          testID="serverSettings.cancelButton"
        >
          <Text style={[styles.headerAction, isProbing ? styles.disabled : null]}>
            {t("Cancel")}
          </Text>
        </Pressable>
        <Text style={styles.title}>{t("Server")}</Text>
        {isProbing ? (
          <ActivityIndicator color={colors.cinnabar} style={styles.saveSpinner} />
        ) : (
          <Pressable
            accessibilityLabel={t("Save")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              void save();
            }}
            testID="serverSettings.saveButton"
          >
            <Text style={[styles.headerAction, styles.saveAction]}>{t("Save")}</Text>
          </Pressable>
        )}
      </View>
      <Hairline />
      <View style={styles.body}>
        <Text style={styles.label}>{t("Server address")}</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isProbing}
          keyboardType="url"
          onChangeText={(value) => {
            setUrlText(value);
            if (errorMessage) setErrorMessage(null);
          }}
          placeholder="https://api.example.com"
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.input}
          testID="serverSettings.urlField"
          value={urlText}
        />
        <Text style={styles.footer}>
          {t(
            "The TeamClu Cloud API this app talks to. Everything else — including the message broker — is discovered from it.",
          )}
        </Text>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Ionicons color={colors.cinnabar} name="warning" size={16} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {isOverridden && bundledDefault ? (
          <View style={styles.resetBlock}>
            <Pressable
              accessibilityRole="button"
              disabled={isProbing}
              onPress={() => {
                setUrlText(bundledDefault);
                setErrorMessage(null);
              }}
              style={({ pressed }) => [
                styles.resetButton,
                pressed && !isProbing ? styles.pressed : null,
              ]}
              testID="serverSettings.useDefaultButton"
            >
              <Text style={styles.resetLabel}>{t("Use default server")}</Text>
            </Pressable>
            <Text style={styles.resetHint}>{t("Default: {{url}}", { url: bundledDefault })}</Text>
            {getCloudApiUrlOverride() ? (
              <Text style={styles.resetHint}>
                {t("Currently: {{url}}", { url: getCloudApiUrlOverride() })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.md,
    padding: spacing.xl,
  },
  disabled: {
    opacity: 0.4,
  },
  errorBanner: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.card,
    flexDirection: "row",
    gap: 6,
    padding: spacing.sm,
  },
  errorText: {
    color: colors.onyx,
    flex: 1,
    ...typography.caption,
  },
  footer: {
    color: colors.basalt,
    ...typography.caption,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerAction: {
    color: colors.onyx,
    minWidth: 56,
    ...typography.body,
  },
  input: {
    backgroundColor: colors.pebble,
    borderRadius: radii.card,
    color: colors.onyx,
    padding: spacing.md,
    ...typography.body,
    fontFamily: "monospace",
  },
  label: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  pressed: {
    opacity: 0.85,
  },
  resetBlock: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  resetButton: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
  },
  resetHint: {
    color: colors.slate,
    ...typography.caption,
  },
  resetLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  saveAction: {
    color: colors.cinnabar,
    fontWeight: "600",
    textAlign: "right",
  },
  saveSpinner: {
    minWidth: 56,
  },
  sheet: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  title: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
});
