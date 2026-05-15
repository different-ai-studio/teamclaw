import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { buildConfig } from "@/lib/build-config";
import { useAppVersion } from "@/lib/version";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginScreen() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const { sendOtp, verifyOtp, resetOtp, otpEmail, loading, errorMessage } = useAuthStore();
  const appVersion = useAppVersion();

  const onSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendOtp(email);
  };

  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    await verifyOtp(code);
  };

  const onBack = () => {
    setCode("");
    resetOtp();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
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

      {otpEmail ? (
        <form
          onSubmit={onVerify}
          className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-paper p-7"
        >
          <div className="space-y-1.5">
            <h2 className="text-[17px] font-semibold text-foreground">
              {t("auth.enterCode", "Enter the code")}
            </h2>
            <p className="text-[13px] text-muted-foreground">
              {t("auth.codeSent", "We sent an 8-digit code to {{email}}.", { email: otpEmail })}
            </p>
          </div>
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-ink-2">
              {t("auth.code", "Code")}
            </label>
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              required
              autoFocus
              maxLength={8}
              className="h-11 text-center text-lg tracking-[0.35em] font-mono"
            />
          </div>
          {errorMessage && <p className="text-[12px] text-destructive">{errorMessage}</p>}
          <Button
            type="submit"
            disabled={loading || code.length !== 8}
            className="h-10 w-full bg-coral text-paper hover:bg-coral/90 disabled:bg-coral/40 disabled:text-paper"
          >
            {loading ? t("auth.verifying", "Verifying…") : t("auth.verify", "Verify")}
          </Button>
          <button
            type="button"
            onClick={onBack}
            className="block w-full text-center text-[12px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("auth.useDifferentEmail", "Use a different email")}
          </button>
        </form>
      ) : (
        <form
          onSubmit={onSendEmail}
          className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-paper p-7"
        >
          <div className="space-y-1.5">
            <h2 className="text-[17px] font-semibold text-foreground">
              {t("auth.signIn", "Sign in")}
            </h2>
            <p className="text-[13px] text-muted-foreground">
              {t("auth.willEmailCode", "We'll email you an 8-digit code.")}
            </p>
          </div>
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-ink-2">
              {t("auth.email", "Email")}
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder={t("auth.emailPlaceholder", "you@example.com")}
              className="h-10"
            />
          </div>
          {errorMessage && <p className="text-[12px] text-destructive">{errorMessage}</p>}
          <Button
            type="submit"
            disabled={loading || !email}
            className="h-10 w-full bg-coral text-paper hover:bg-coral/90 disabled:bg-coral/40 disabled:text-paper"
          >
            {loading ? t("auth.sending", "Sending…") : t("auth.sendCode", "Send code")}
          </Button>
        </form>
      )}

      <p className="mt-6 font-mono text-[11px] text-faint">v{appVersion}</p>
    </div>
  );
}
