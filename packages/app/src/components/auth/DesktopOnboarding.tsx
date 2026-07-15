import { useState } from "react";
import { ArrowLeft, Link2, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseInviteTokenInput } from "@/lib/invite-deeplink";
import { getEffectiveServerConfigSync } from "@/lib/server-config";
import { useAppVersion } from "@/lib/version";
import { useAuthStore } from "@/stores/auth-store";
import { LoginScreen } from "./LoginScreen";

type Step = "choose" | "login" | "invite";

function Shell({ children }: { children: React.ReactNode }) {
  const appVersion = useAppVersion();
  const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl;
  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground">
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">
        {children}
        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
        {cloudApiUrl && (
          <p className="mt-0.5 text-center font-mono text-[10px] text-faint/70">
            {cloudApiUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}
          </p>
        )}
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-5 inline-flex w-fit items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {t("onboarding.common.back", "Back")}
    </button>
  );
}

function DetailFrame({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <BackButton onClick={onBack} />
        {children}
      </div>
    </Shell>
  );
}

function ChoiceRow({
  icon,
  title,
  caption,
  primary,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[14px] border border-border bg-paper p-3 text-left transition-colors hover:bg-selected/45 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={[
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
          primary ? "bg-coral text-coral-foreground" : "bg-panel text-ink-2",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
    </button>
  );
}

function ChooseStep({
  onQuickTrial,
  onLogin,
  onInvite,
}: {
  onQuickTrial: () => void;
  onLogin: () => void;
  onInvite: () => void;
}) {
  const { t } = useTranslation();
  const { loading, errorMessage } = useAuthStore();
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <div className="mb-5">
          <h1 className="text-[24px] font-semibold text-foreground">
            {t("auth.onboarding.setupTitle", "Choose setup")}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            {t(
              "auth.onboarding.setupDesc",
              "Try it first, sign in, join a team, or connect a self-hosted server.",
            )}
          </p>
        </div>
        <div className="space-y-3">
          <ChoiceRow
            primary
            icon={<LogIn className="h-4 w-4" />}
            title={t("auth.onboarding.signInOrRegister", "Sign in or register")}
            caption={t("auth.onboarding.signInOrRegisterDesc", "Continue with an email code, matching the iOS flow.")}
            disabled={loading}
            onClick={onLogin}
          />
          <ChoiceRow
            icon={<Link2 className="h-4 w-4" />}
            title={t("auth.onboarding.joinTeam", "Join the team")}
            caption={t("auth.onboarding.joinTeamDesc", "Paste an invite link or token to join an existing team.")}
            disabled={loading}
            onClick={onInvite}
          />
        </div>
        <div className="mt-5 flex items-center justify-center gap-3 text-[12px] text-muted-foreground">
          <button
            type="button"
            disabled={loading}
            onClick={onQuickTrial}
            className="rounded-[6px] px-1 py-0.5 underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading
              ? t("auth.onboarding.startingTrial", "Preparing…")
              : t("auth.onboarding.quickTrial", "Quick trial")}
          </button>
        </div>
        {errorMessage && (
          <p className="mt-4 rounded-[8px] border border-destructive/20 bg-paper px-3 py-2 text-[12px] leading-5 text-destructive">
            {errorMessage}
          </p>
        )}
      </div>
    </Shell>
  );
}

function InviteStep({ onBack, onNeedLogin }: { onBack: () => void; onNeedLogin: () => void }) {
  const { t } = useTranslation();
  const { setPendingInviteToken, errorMessage } = useAuthStore();
  const [raw, setRaw] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const token = parseInviteTokenInput(raw);
    if (!token) {
      setLocalError(t("auth.onboarding.inviteParseError", "Enter a valid invite token or invite link."));
      return;
    }
    setLocalError(null);
    // Member invites require a real account: stash the token and send the user
    // to sign in. The invite is claimed automatically once they're signed in.
    setPendingInviteToken(token);
    onNeedLogin();
  };

  return (
    <DetailFrame onBack={onBack}>
      <form onSubmit={submit} className="rounded-[16px] border border-border bg-paper p-5">
        <h1 className="text-[18px] font-semibold">{t("auth.onboarding.inviteTitle", "Join the team")}</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t("auth.onboarding.inviteDesc", "Paste an invite link or token, then sign in to join. The invite is claimed once you're signed in.")}
        </p>
        <label className="mt-5 block space-y-2">
          <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.inviteLabel", "Invite link or token")}</span>
          <Input value={raw} onChange={(event) => setRaw(event.target.value)} className="h-10 font-mono text-[12px]" />
        </label>
        {(localError || errorMessage) && (
          <p className="mt-3 text-[12px] text-destructive">{localError || errorMessage}</p>
        )}
        <Button type="submit" disabled={!raw.trim()} className="mt-5 h-10 w-full bg-coral text-coral-foreground">
          {t("auth.onboarding.inviteContinueToSignIn", "Continue to sign in")}
        </Button>
      </form>
    </DetailFrame>
  );
}

export function DesktopOnboarding() {
  const [step, setStep] = useState<Step>("choose");
  const signInAnonymously = useAuthStore((state) => state.signInAnonymously);

  if (step === "login") {
    return (
      <DetailFrame onBack={() => setStep("choose")}>
        <LoginScreen embedded />
      </DetailFrame>
    );
  }
  if (step === "invite") return <InviteStep onBack={() => setStep("choose")} onNeedLogin={() => setStep("login")} />;

  return (
    <ChooseStep
      onQuickTrial={() => void signInAnonymously()}
      onLogin={() => setStep("login")}
      onInvite={() => setStep("invite")}
    />
  );
}
