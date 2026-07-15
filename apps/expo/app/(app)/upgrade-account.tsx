import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { supabase } from "../../src/lib/supabase/client";
import {
  OTP_CODE_LENGTH,
  sanitizeOtpInput,
} from "../../src/features/onboarding/auth-otp";
import type { OAuthProvider } from "../../src/features/onboarding/onboarding-oauth";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { showToast } from "../../src/ui/Toast";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

WebBrowser.maybeCompleteAuthSession();

export default function UpgradeAccountRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  // Set once a code has been emailed — switches the screen to code entry.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = isBusy || state.isBusy;

  const isCodeStep = pendingEmail !== null;
  const canSendCode =
    !busy &&
    email.trim().length > 0 &&
    /^\S+@\S+\.\S+$/.test(email.trim());
  const canVerify = !busy && code.length === OTP_CODE_LENGTH;

  // Step 1: email a verification code to attach `email` to the current
  // (anonymous) user. GoTrue's email_change flow keeps the same user_id, so
  // existing teams / agents / sessions stay attached.
  const handleSendCode = async () => {
    if (!canSendCode) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await supabase.auth.updateUser({ email: email.trim() });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setPendingEmail(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the code.");
    } finally {
      setIsBusy(false);
    }
  };

  // Step 2: confirm the code and finalize the upgrade.
  const handleVerifyCode = async () => {
    if (!canVerify || !pendingEmail) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await supabase.auth.verifyOtp({
        email: pendingEmail,
        token: code,
        type: "email_change",
      });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      showToast("success", "Account upgraded.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upgrade account.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleUseDifferentEmail = () => {
    setPendingEmail(null);
    setCode("");
    setError(null);
  };

  const handleOAuthUpgrade = async (provider: OAuthProvider) => {
    if (busy) return;
    setError(null);
    try {
      await controller.linkIdentityWithOAuth(provider, {
        redirectTo: Linking.createURL("auth/callback"),
        openAuthSession: WebBrowser.openAuthSessionAsync,
      });
      showToast("success", "Account connected.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect account.");
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Upgrade account</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", default: undefined })}
        style={styles.body}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.lede}>
            {isCodeStep
              ? `Enter the ${OTP_CODE_LENGTH}-digit code we emailed to ${pendingEmail}.`
              : state.isAnonymous
                ? "Attach an email, Apple, or Google identity so you don't lose this workspace next time you launch Teamclaw."
                : "Change this account's email or connect another sign-in identity."}
          </Text>

          {isCodeStep ? (
            <View style={styles.card}>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Code</Text>
                <TextInput
                  accessibilityLabel={`${OTP_CODE_LENGTH}-digit code`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  keyboardType="number-pad"
                  maxLength={OTP_CODE_LENGTH}
                  onChangeText={(value) => setCode(sanitizeOtpInput(value))}
                  placeholder={`${OTP_CODE_LENGTH}-digit code`}
                  placeholderTextColor={colors.slate}
                  selectionColor={colors.cinnabar}
                  style={styles.input}
                  textContentType="oneTimeCode"
                  value={code}
                />
              </View>
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Email</Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.slate}
                  selectionColor={colors.cinnabar}
                  style={styles.input}
                  textContentType="emailAddress"
                  value={email}
                />
              </View>
            </View>
          )}

          {error || state.errorMessage ? (
            <Text style={styles.errorText}>{error ?? state.errorMessage}</Text>
          ) : null}

          {isCodeStep ? (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={!canVerify}
                onPress={handleVerifyCode}
                style={({ pressed }) => [
                  styles.cta,
                  canVerify ? styles.ctaActive : styles.ctaInactive,
                  pressed && canVerify ? styles.ctaPressed : null,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={hai.paper} />
                ) : (
                  <Text
                    style={[
                      styles.ctaText,
                      canVerify ? styles.ctaTextActive : styles.ctaTextInactive,
                    ]}
                  >
                    Verify
                  </Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={handleUseDifferentEmail}
                style={styles.linkButton}
              >
                <Text style={styles.linkText}>Use a different email</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={!canSendCode}
              onPress={handleSendCode}
              style={({ pressed }) => [
                styles.cta,
                canSendCode ? styles.ctaActive : styles.ctaInactive,
                pressed && canSendCode ? styles.ctaPressed : null,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={hai.paper} />
              ) : (
                <Text
                  style={[
                    styles.ctaText,
                    canSendCode ? styles.ctaTextActive : styles.ctaTextInactive,
                  ]}
                >
                  Send code
                </Text>
              )}
            </Pressable>
          )}

          {!isCodeStep ? (
            <>
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.dividerLine} />
              </View>

              <View style={styles.socialColumn}>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => {
                    void handleOAuthUpgrade("apple");
                  }}
                  style={({ pressed }) => [
                    styles.socialButton,
                    pressed && !busy ? styles.pressed : null,
                    busy ? styles.disabled : null,
                  ]}
                >
                  <View style={styles.socialIconWrap}>
                    <Ionicons color={colors.onyx} name="logo-apple" size={19} />
                  </View>
                  <Text style={styles.socialLabel}>Upgrade with Apple</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => {
                    void handleOAuthUpgrade("google");
                  }}
                  style={({ pressed }) => [
                    styles.socialButton,
                    pressed && !busy ? styles.pressed : null,
                    busy ? styles.disabled : null,
                  ]}
                >
                  <View style={styles.socialIconWrap}>
                    <Ionicons color={colors.onyx} name="globe-outline" size={19} />
                  </View>
                  <Text style={styles.socialLabel}>Upgrade with Google</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          <Text style={styles.footnote}>
            After upgrading, sign in with the same identity next time you
            launch Teamclaw. Existing teams, agents, and sessions stay
            attached.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  cta: {
    alignItems: "center",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  ctaActive: {
    backgroundColor: hai.cinnabar,
  },
  ctaInactive: {
    backgroundColor: hai.pebble,
  },
  ctaPressed: {
    opacity: 0.88,
  },
  ctaText: {
    ...typography.cardTitle,
  },
  ctaTextActive: {
    color: hai.paper,
  },
  ctaTextInactive: {
    color: hai.slate,
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
    ...typography.caption,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  field: {
    gap: spacing.xs,
    padding: spacing.md,
  },
  fieldLabel: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  footnote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  input: {
    color: colors.onyx,
    padding: 0,
    ...typography.body,
  },
  lede: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  linkButton: {
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  linkText: {
    color: colors.slate,
    ...typography.caption,
  },
  pressed: {
    opacity: 0.8,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  socialButton: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
  socialColumn: {
    gap: spacing.sm,
  },
  socialIconWrap: {
    alignItems: "center",
    backgroundColor: colors.mist,
    borderRadius: 999,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  socialLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
});
