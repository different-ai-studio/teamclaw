import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, radii, shadows, spacing, typography } from "../../../ui/theme";
import { OTP_CODE_LENGTH, sanitizeOtpInput } from "../auth-otp";

type AuthScreenProps = {
  errorMessage: string | null;
  isBusy: boolean;
  pendingEmail: string | null;
  onBack: () => void;
  onRequestOtp: (email: string) => Promise<void>;
  onVerifyOtp: (token: string) => Promise<void>;
  onSignInWithPassword: (email: string, password: string) => Promise<void>;
  onResetPendingEmail: () => void;
  onSignInWithApple?: () => Promise<void> | void;
  onSignInWithGoogle?: () => Promise<void> | void;
};

/** iOS `LoginView.LoginMethod`, minus `phone` — not implemented here yet. */
type LoginMethod = "email" | "password";

function isValidEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value);
}

/**
 * Port of `apps/ios/AMUXApp/LoginView.swift`: a segmented method picker over
 * email-OTP and email+password, then "Sign in with Apple" / "Sign in with
 * Google" rails below an "or" divider. Guest / private-workspace lives on the
 * ChooseAuthScreen — same as iOS.
 *
 * iOS also offers a `phone` method with a multi-account picker sheet; that is
 * deliberately not ported yet, so the picker here shows two tabs rather than
 * three.
 */
export function AuthScreen({
  errorMessage,
  isBusy,
  pendingEmail,
  onBack,
  onRequestOtp,
  onVerifyOtp,
  onSignInWithPassword,
  onResetPendingEmail,
  onSignInWithApple,
  onSignInWithGoogle,
}: AuthScreenProps) {
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<LoginMethod>("email");

  useEffect(() => {
    if (pendingEmail) setEmail(pendingEmail);
  }, [pendingEmail]);

  const isCodeStep = pendingEmail != null;

  const sendCode = async () => {
    const next = email.trim().toLowerCase();
    if (!isValidEmail(next)) return;
    try {
      await onRequestOtp(next);
    } catch {
      // The onboarding store records the message into `errorMessage` and
      // rethrows; it is already on screen. Swallowing here only stops the
      // unhandled rejection.
    }
  };

  const submitPassword = async () => {
    const next = email.trim().toLowerCase();
    if (!isValidEmail(next) || password.length === 0) return;
    try {
      await onSignInWithPassword(next, password);
    } catch {
      // Already surfaced via `errorMessage` — see sendCode.
    }
  };

  const verify = async () => {
    const next = code.trim();
    if (next.length !== OTP_CODE_LENGTH) return;
    try {
      await onVerifyOtp(next);
    } catch {
      // Already surfaced via `errorMessage` — see sendCode.
    }
  };

  const useDifferentEmail = () => {
    setCode("");
    onResetPendingEmail();
  };

  const handleApple = () => {
    if (onSignInWithApple) {
      void onSignInWithApple();
      return;
    }
    Alert.alert("Sign in with Apple", "Coming soon on Expo. Use email for now.");
  };

  const handleGoogle = () => {
    if (onSignInWithGoogle) {
      void onSignInWithGoogle();
      return;
    }
    Alert.alert("Sign in with Google", "Coming soon on Expo. Use email for now.");
  };

  const canSubmit = isCodeStep
    ? code.length === OTP_CODE_LENGTH
    : method === "password"
      ? email.trim().length > 0 && password.length > 0
      : email.trim().length > 0;

  // Mirrors iOS `headerSubtitle`: the copy tracks the selected method, so the
  // screen never promises a code when the user picked password.
  const subtitle = isCodeStep
    ? "Check your inbox for a 6-digit code."
    : method === "password"
      ? "Use your email and password to sign in."
      : "We'll email you a 6-digit code.";

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.screen}
    >
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        hitSlop={12}
        onPress={onBack}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Ionicons color={colors.onyx} name="chevron-back" size={26} />
      </Pressable>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>
            {isCodeStep ? "Enter the code" : "Sign in"}
          </Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>

        {!isCodeStep ? (
          <View style={styles.methodPicker} testID="login.methodPicker">
            <MethodTab
              disabled={isBusy}
              label="Email"
              onPress={() => setMethod("email")}
              selected={method === "email"}
            />
            <MethodTab
              disabled={isBusy}
              label="Password"
              onPress={() => setMethod("password")}
              selected={method === "password"}
            />
          </View>
        ) : null}

        {isCodeStep ? (
          <View style={styles.section}>
            <Text style={styles.helper}>
              Code sent to{" "}
              <Text style={styles.helperStrong}>{pendingEmail}</Text>
            </Text>

            <View style={styles.authField}>
              <TextInput
                accessibilityLabel="6-digit code"
                editable={!isBusy}
                keyboardType="number-pad"
                maxLength={OTP_CODE_LENGTH}
                onChangeText={(value) => setCode(sanitizeOtpInput(value))}
                placeholder="6-digit code"
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.fieldText}
                textContentType="oneTimeCode"
                value={code}
              />
            </View>

            <PrimaryButton
              busy={isBusy}
              enabled={canSubmit}
              label="Verify"
              onPress={() => {
                void verify();
              }}
            />

            <Pressable
              accessibilityRole="button"
              disabled={isBusy}
              onPress={useDifferentEmail}
              style={({ pressed }) => [
                styles.linkButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.linkText}>Use a different email</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.section}>
            <View style={styles.authField}>
              <TextInput
                accessibilityLabel="Email"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!isBusy}
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.fieldText}
                testID="login.emailField"
                textContentType={method === "password" ? "username" : "emailAddress"}
                value={email}
              />
            </View>

            {method === "password" ? (
              <View style={styles.authField}>
                <TextInput
                  accessibilityLabel="Password"
                  autoCapitalize="none"
                  autoComplete="current-password"
                  autoCorrect={false}
                  editable={!isBusy}
                  onChangeText={setPassword}
                  onSubmitEditing={() => {
                    void submitPassword();
                  }}
                  placeholder="Password"
                  placeholderTextColor={colors.slate}
                  returnKeyType="go"
                  secureTextEntry
                  selectionColor={colors.cinnabar}
                  style={styles.fieldText}
                  testID="login.passwordField"
                  textContentType="password"
                  value={password}
                />
              </View>
            ) : null}

            <PrimaryButton
              busy={isBusy}
              enabled={canSubmit}
              label={method === "password" ? "Sign in" : "Send code"}
              onPress={() => {
                void (method === "password" ? submitPassword() : sendCode());
              }}
            />
          </View>
        )}

        {errorMessage ? (
          <Text style={styles.error}>{errorMessage}</Text>
        ) : null}

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.socialColumn}>
          <SocialButton
            disabled={isBusy}
            icon="logo-apple"
            label="Sign in with Apple"
            onPress={handleApple}
          />
          <SocialButton
            disabled={isBusy}
            icon="globe-outline"
            label="Sign in with Google"
            onPress={handleGoogle}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** One segment of the method picker — RN has no built-in segmented control. */
function MethodTab({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.methodTab,
        selected ? styles.methodTabSelected : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text
        style={[
          styles.methodTabLabel,
          selected ? styles.methodTabLabelSelected : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function PrimaryButton({
  busy,
  enabled,
  label,
  onPress,
}: {
  busy: boolean;
  enabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const disabled = !enabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        enabled ? styles.primaryButtonEnabled : styles.primaryButtonDisabled,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <View style={styles.primaryButtonContent}>
        {busy ? (
          <ActivityIndicator
            color={enabled ? "#FFFFFF" : colors.slate}
            size="small"
          />
        ) : null}
        <Text
          style={[
            styles.primaryButtonLabel,
            enabled
              ? styles.primaryButtonLabelEnabled
              : styles.primaryButtonLabelDisabled,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function SocialButton({
  disabled,
  icon,
  label,
  onPress,
}: {
  disabled?: boolean;
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.socialButton,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <View style={styles.socialIconWrap}>
        <Ionicons color={colors.onyx} name={icon} size={19} />
      </View>
      <Text style={styles.socialLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  authField: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backButton: {
    left: spacing.md,
    padding: spacing.xs,
    position: "absolute",
    top: spacing.sm,
    zIndex: 10,
  },
  content: {
    gap: 24,
    paddingBottom: 36,
    paddingHorizontal: 24,
    paddingTop: 72,
  },
  disabled: {
    opacity: 0.5,
  },
  divider: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
  },
  dividerLine: {
    backgroundColor: colors.hairline,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    color: colors.slate,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
  },
  error: {
    color: colors.cinnabarDeep,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    lineHeight: 18,
  },
  fieldText: {
    color: colors.onyx,
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    lineHeight: 22,
    padding: 0,
  },
  header: {
    gap: 10,
  },
  helper: {
    color: colors.basalt,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    lineHeight: 18,
  },
  helperStrong: {
    color: colors.basalt,
    fontWeight: "700",
  },
  linkButton: {
    alignItems: "center",
    paddingVertical: 6,
  },
  linkText: {
    color: colors.cinnabarDeep,
    fontFamily: typography.sans.fontFamily,
    fontSize: 13,
    fontWeight: "500",
  },
  pressed: {
    opacity: 0.85,
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: 18,
    justifyContent: "center",
    paddingVertical: 15,
  },
  primaryButtonContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
  },
  primaryButtonDisabled: {
    backgroundColor: "rgba(226,223,217,0.82)",
  },
  primaryButtonEnabled: {
    backgroundColor: colors.cinnabar,
    elevation: 3,
    shadowColor: colors.onyx,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
  },
  primaryButtonLabel: {
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    fontWeight: "600",
  },
  primaryButtonLabelDisabled: {
    color: colors.slate,
  },
  primaryButtonLabelEnabled: {
    color: "#FFFFFF",
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  // Stands in for iOS's `.pickerStyle(.segmented)` — a recessed track with a
  // raised selected segment. React Native ships no segmented control.
  methodPicker: {
    backgroundColor: colors.pebble,
    borderRadius: radii.button + 2,
    flexDirection: "row",
    gap: 2,
    padding: 2,
  },
  methodTab: {
    alignItems: "center",
    borderRadius: radii.button,
    flex: 1,
    paddingVertical: 7,
  },
  methodTabLabel: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "500",
  },
  methodTabLabelSelected: {
    color: colors.onyx,
    fontWeight: "600",
  },
  methodTabSelected: {
    backgroundColor: colors.paper,
    ...shadows.card,
  },
  section: {
    gap: 12,
  },
  socialColumn: {
    gap: 12,
  },
  socialButton: {
    alignItems: "center",
    backgroundColor: "rgba(248,246,241,0.82)",
    borderColor: colors.hairline,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    paddingVertical: 15,
  },
  socialIconWrap: {
    alignItems: "center",
    width: 24,
  },
  socialLabel: {
    color: colors.onyx,
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    fontWeight: "600",
  },
  subtitle: {
    color: colors.basalt,
    fontFamily: typography.sans.fontFamily,
    fontSize: 17,
    lineHeight: 23,
  },
  title: {
    color: colors.onyx,
    fontFamily: typography.serif.fontFamily,
    fontSize: 38,
    fontWeight: "400",
    letterSpacing: -0.5,
    lineHeight: 44,
  },
});
