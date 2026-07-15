import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { buildConfig } from "@/lib/build-config";
import { hasBackendConfig } from "@/lib/backend";
import { getEffectiveServerConfigSync } from "@/lib/server-config";
import { useAppVersion } from "@/lib/version";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/lib/utils";
import { GoogleIcon, WechatIcon } from "./oauth-icons";
import { WebSsoOverlay } from "./WebSsoOverlay";
import type { OAuthProvider } from "@/lib/auth";

export function OAuthButtons() {
  const { t } = useTranslation();
  const { signInWithOAuth, cancelOAuth, signInWithWebSso, cancelWebSso, loading, oauthPending, webSsoPending } = useAuthStore();
  const auth = buildConfig.features?.auth;
  const showGoogle = isTauri() && Boolean(auth?.google);
  const showWechat = isTauri() && Boolean(auth?.wechat);
  const showWebSso = isTauri() && Boolean(auth?.webSSO);
  if (!showGoogle && !showWechat && !showWebSso) return null;

  const Btn = ({ provider, icon, label }: { provider: OAuthProvider; icon: React.ReactNode; label: string }) => (
    <button
      type="button"
      disabled={loading}
      onClick={() => void signInWithOAuth(provider)}
      className="flex h-10 w-full items-center justify-center gap-2 rounded-[8px] border border-border bg-paper text-[13px] font-medium text-foreground transition-colors hover:bg-selected/45 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );

  // While web SSO window is open, show a waiting message + cancel affordance.
  // The native webview covers the React layer, so the visible back/close control
  // lives in WebSsoOverlay (rendered above the webview rect via a portal).
  if (webSsoPending) {
    return (
      <div className="space-y-2">
        <WebSsoOverlay onCancel={() => cancelWebSso()} />
        <div className="flex items-center gap-2 text-[11px] text-faint">
          <span className="h-px flex-1 bg-border" />
          {t("auth.orContinueWith", "or continue with")}
          <span className="h-px flex-1 bg-border" />
        </div>
        <p className="text-center text-[12px] text-muted-foreground">
          {t("auth.webSsoWaiting", "Finish signing in in the window, then come back.")}
        </p>
        <button
          type="button"
          onClick={() => cancelWebSso()}
          className="flex h-10 w-full items-center justify-center rounded-[8px] border border-border bg-paper text-[13px] font-medium text-foreground transition-colors hover:bg-selected/45"
        >
          {t("auth.oauthCancel", "Cancel and try another way")}
        </button>
      </div>
    );
  }

  // While a provider page is open and the loopback is awaiting, give the user an
  // explicit escape. Without it a broken provider page leaves every sign-in
  // control disabled until the long loopback timeout, so the app looks frozen.
  if (oauthPending) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-faint">
          <span className="h-px flex-1 bg-border" />
          {t("auth.orContinueWith", "or continue with")}
          <span className="h-px flex-1 bg-border" />
        </div>
        <p className="text-center text-[12px] text-muted-foreground">
          {t("auth.oauthWaiting", "Finish signing in in your browser, then come back.")}
        </p>
        <button
          type="button"
          onClick={() => cancelOAuth()}
          className="flex h-10 w-full items-center justify-center rounded-[8px] border border-border bg-paper text-[13px] font-medium text-foreground transition-colors hover:bg-selected/45"
        >
          {t("auth.oauthCancel", "Cancel and try another way")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-faint">
        <span className="h-px flex-1 bg-border" />
        {t("auth.orContinueWith", "or continue with")}
        <span className="h-px flex-1 bg-border" />
      </div>
      {showWechat && (
        <Btn provider="wechat" icon={<WechatIcon className="h-4 w-4" />} label={t("auth.signInWithWechat", "Sign in with WeChat")} />
      )}
      {showGoogle && (
        <Btn provider="google" icon={<GoogleIcon className="h-4 w-4" />} label={t("auth.signInWithGoogle", "Sign in with Google")} />
      )}
      {showWebSso && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void signInWithWebSso()}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-[8px] border border-border bg-paper text-[13px] font-medium text-foreground transition-colors hover:bg-selected/45 disabled:opacity-50"
        >
          {t("auth.signInWithWebSso", "Quick sign-in")}
        </button>
      )}
    </div>
  );
}

interface LoginScreenProps {
  embedded?: boolean;
  onBack?: () => void;
}

export function LoginScreen({ embedded = false, onBack }: LoginScreenProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const {
    sendOtp,
    verifyOtp,
    resetOtp,
    signInAnonymously,
    sendPhoneOtp,
    verifyPhoneOtp,
    selectPhoneUser,
    otpEmail,
    otpPhone,
    phoneMultiUsers,
    loading,
    errorMessage,
  } = useAuthStore();
  const [phone, setPhone] = useState("+86");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const phoneEnabled = isTauri() && Boolean(buildConfig.features?.auth?.phone);
  const appVersion = useAppVersion();
  const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl;
  const onSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendOtp(email);
  };

  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    await verifyOtp(code);
  };

  const onSendPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendPhoneOtp(phone);
  };

  const onVerifyPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    await verifyPhoneOtp(code);
  };

  const onUseDifferentContact = () => {
    setCode("");
    resetOtp();
  };

  const onQuickTrial = async () => {
    await signInAnonymously();
  };
  const cardClassName = embedded
    ? "w-full space-y-5 rounded-[16px] border border-border bg-paper p-5"
    : "w-full max-w-sm space-y-5 rounded-2xl border border-border bg-paper p-7";
  const serverConfigRequired = !hasBackendConfig();
  const serverConfigMessage = t(
    "auth.serverConfigRequired",
    "Supabase is not configured. Go back and choose self-hosted server before signing in.",
  );

  return (
    <div className={embedded ? "w-full" : "flex min-h-screen flex-col items-center justify-center bg-background p-6"}>
      {!embedded && (
        <div className="mb-8 flex flex-col items-center gap-3">
          <img
            src="/logo.png"
            alt={`${buildConfig.app.name} logo`}
            width={128}
            height={128}
            className="h-20 w-20 object-contain"
          />
          <div className="text-center">
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
              {buildConfig.app.name}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("auth.tagline", "AI Ally · AI Teammate")}
            </p>
          </div>
        </div>
      )}

      {embedded && onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-5 w-full max-w-sm text-left text-[12px] text-muted-foreground hover:text-foreground"
        >
          {t("onboarding.common.back", "Back")}
        </button>
      )}

      {(otpEmail || otpPhone) ? (
        phoneMultiUsers.length > 0 ? (
          <div className={cardClassName}>
            <div className="space-y-1.5">
              <h2 className="text-[17px] font-semibold text-foreground">
                {t("auth.selectAccount", "Select Account")}
              </h2>
              <p className="text-[13px] text-muted-foreground">
                {t("auth.multipleAccountsForPhone", "Multiple accounts are linked to {{phone}}.", { phone: otpPhone })}
              </p>
            </div>
            <div className="space-y-2">
              {phoneMultiUsers.map((user) => (
                <Button
                  key={user.id}
                  type="button"
                  disabled={loading}
                  onClick={() => void selectPhoneUser(user.id)}
                  className="h-auto w-full justify-start bg-selected/40 text-foreground hover:bg-selected/70 disabled:opacity-50 px-4 py-3"
                >
                  <span className="flex flex-col items-start">
                    <span className="text-[14px] font-medium">{user.orgName || user.nickname || user.email}</span>
                    <span className="text-[12px] text-muted-foreground">{user.nickname || user.email}</span>
                  </span>
                </Button>
              ))}
            </div>
            {errorMessage && (
              <p className="text-[12px] text-destructive">{errorMessage}</p>
            )}
            <button
              type="button"
              onClick={onUseDifferentContact}
              className="block w-full text-center text-[12px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("auth.useDifferentPhone", "Use a different number")}
            </button>
          </div>
        ) : (
        <form
          onSubmit={otpPhone ? onVerifyPhone : onVerify}
          className={cardClassName}
        >
          <div className="space-y-1.5">
            <h2 className="text-[17px] font-semibold text-foreground">
              {t("auth.enterCode", "Enter the code")}
            </h2>
            <p className="text-[13px] text-muted-foreground">
              {otpPhone
                ? t("auth.codeSentPhone", "We sent a 6-digit code to {{phone}}.", { phone: otpPhone })
                : t("auth.codeSent", "We sent a 6-digit code to {{email}}.", { email: otpEmail })}
            </p>
          </div>
          <label className="block space-y-2">
            <span className="block text-[12px] font-medium text-ink-2">
              {t("auth.code", "Code")}
            </span>
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              autoFocus
              maxLength={6}
              className="h-11 text-center text-lg tracking-[0.35em] font-mono"
            />
          </label>
          {(serverConfigRequired || errorMessage) && (
            <p className="text-[12px] text-destructive">
              {serverConfigRequired ? serverConfigMessage : errorMessage}
            </p>
          )}
          <Button
            type="submit"
            disabled={serverConfigRequired || loading || code.length !== 6}
            className="h-10 w-full bg-coral text-paper hover:bg-coral/90 disabled:bg-coral/40 disabled:text-paper"
          >
            {loading ? t("auth.verifying", "Verifying…") : t("auth.verify", "Verify")}
          </Button>
          <button
            type="button"
            onClick={onUseDifferentContact}
            className="block w-full text-center text-[12px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {otpPhone
              ? t("auth.useDifferentPhone", "Use a different number")
              : t("auth.useDifferentEmail", "Use a different email")}
          </button>
        </form>
        )
      ) : (
        <form onSubmit={method === "phone" ? onSendPhone : onSendEmail} className={cardClassName}>
          {phoneEnabled && (
            <div className="flex rounded-[8px] border border-border p-0.5 text-[12px] font-medium">
              <button
                type="button"
                onClick={() => setMethod("email")}
                className={`flex-1 rounded-[6px] py-1.5 transition-colors ${method === "email" ? "bg-selected/60 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("auth.methodEmail", "Email")}
              </button>
              <button
                type="button"
                onClick={() => setMethod("phone")}
                className={`flex-1 rounded-[6px] py-1.5 transition-colors ${method === "phone" ? "bg-selected/60 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("auth.methodPhone", "Phone")}
              </button>
            </div>
          )}
          <div className="space-y-1.5">
            <h2 className="text-[17px] font-semibold text-foreground">
              {t("auth.signIn", "Sign in")}
            </h2>
            <p className="text-[13px] text-muted-foreground">
              {method === "phone"
                ? t("auth.willSmsCode", "We'll text you a 6-digit code.")
                : t("auth.willEmailCode", "We'll email you a 6-digit code.")}
            </p>
          </div>
          {method === "phone" ? (
            <label className="block space-y-2">
              <span className="block text-[12px] font-medium text-ink-2">
                {t("auth.phone", "Phone number")}
              </span>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                autoFocus
                placeholder={t("auth.phonePlaceholder", "+8613800138000")}
                className="h-10"
              />
            </label>
          ) : (
            <label className="block space-y-2">
              <span className="block text-[12px] font-medium text-ink-2">
                {t("auth.email", "Email")}
              </span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                placeholder={t("auth.emailPlaceholder", "you@example.com")}
                className="h-10"
              />
            </label>
          )}
          {(serverConfigRequired || errorMessage) && (
            <p className="text-[12px] text-destructive">
              {serverConfigRequired ? serverConfigMessage : errorMessage}
            </p>
          )}
          {/* phone guard: block the bare "+86" prefix; FC/GoTrue validates the full E.164 number (mirrors iOS) */}
          <Button
            type="submit"
            disabled={serverConfigRequired || loading || (method === "phone" ? phone.length <= 4 : !email)}
            className="h-10 w-full bg-coral text-paper hover:bg-coral/90 disabled:bg-coral/40 disabled:text-paper"
          >
            {loading ? t("auth.sending", "Sending…") : t("auth.sendCode", "Send code")}
          </Button>
          <button
            type="button"
            onClick={() => void onQuickTrial()}
            disabled={serverConfigRequired || loading}
            className="block w-full text-center text-[12px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {loading
              ? t("auth.onboarding.startingTrial", "Preparing…")
              : t("auth.onboarding.quickTrial", "Try anonymously")}
          </button>
          <OAuthButtons />
        </form>
      )}

      {!embedded && (
        <>
          <p className="mt-6 font-mono text-[11px] text-faint">v{appVersion}</p>
          {cloudApiUrl && (
            <p className="mt-0.5 font-mono text-[10px] text-faint/70">
              {cloudApiUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
