import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/auth-store";
import { buildConfig } from "@/lib/build-config";
import { isTauri } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Method = "email" | "phone";

export function UpgradeAccountDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const {
    sendUpgradeEmailOtp,
    verifyUpgradeEmailOtp,
    sendUpgradePhoneOtp,
    verifyUpgradePhoneOtp,
    resetUpgradeOtp,
    upgradeEmail,
    upgradePhone,
    upgradeLoading: loading,
    errorMessage,
  } = useAuthStore();
  // Phone upgrade is only offered when the build enables phone auth (same flag
  // that gates phone login). It uses our partner-aligned send-code + bind-phone.
  const phoneEnabled = isTauri() && Boolean(buildConfig.features?.auth?.phone);
  const [method, setMethod] = useState<Method>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) {
      setEmail("");
      setPhone("");
      setCode("");
      setMethod("email");
      resetUpgradeOtp();
    }
  }, [open, resetUpgradeOtp]);

  const pendingTarget = method === "email" ? upgradeEmail : upgradePhone;

  const onSend = async (event: React.FormEvent) => {
    event.preventDefault();
    if (method === "email") await sendUpgradeEmailOtp(email);
    else await sendUpgradePhoneOtp(phone);
  };

  const onVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok =
      method === "email" ? await verifyUpgradeEmailOtp(code) : await verifyUpgradePhoneOtp(code);
    if (ok) onOpenChange(false);
  };

  const onUseDifferentTarget = () => {
    setCode("");
    resetUpgradeOtp();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("auth.upgrade.title", "Upgrade your account")}</DialogTitle>
          <DialogDescription>
            {t(
              "auth.upgrade.desc",
              "Bind an email or phone so you don't lose access to this workspace.",
            )}
          </DialogDescription>
        </DialogHeader>

        {phoneEnabled && !pendingTarget && (
          <div className="inline-flex w-full gap-1 rounded-md bg-muted p-1">
            {(["email", "phone"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMethod(m);
                  setCode("");
                }}
                className={`flex-1 rounded px-3 py-1 text-xs font-medium transition-colors ${
                  method === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "email" ? t("auth.email", "Email") : t("auth.phone", "Phone number")}
              </button>
            ))}
          </div>
        )}

        {!pendingTarget ? (
          <form onSubmit={onSend} className="space-y-4">
            {method === "email" ? (
              <label className="space-y-2 block">
                <span className="text-[12px] font-medium text-ink-2">{t("auth.email", "Email")}</span>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  placeholder="you@example.com"
                />
              </label>
            ) : (
              <label className="space-y-2 block">
                <span className="text-[12px] font-medium text-ink-2">
                  {t("auth.phone", "Phone number")}
                </span>
                <Input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoFocus
                  placeholder={t("auth.phonePlaceholder", "+8613800138000")}
                />
              </label>
            )}
            {errorMessage && <p className="text-[12px] text-destructive">{errorMessage}</p>}
            <Button
              type="submit"
              disabled={loading || (method === "email" ? !email.trim() : !phone.trim())}
              className="h-10 w-full bg-coral text-paper hover:bg-coral/90"
            >
              {loading
                ? t("auth.upgrade.sending", "Sending…")
                : t("auth.upgrade.sendCode", "Send code")}
            </Button>
          </form>
        ) : (
          <form onSubmit={onVerify} className="space-y-4">
            <p className="text-[12px] text-muted-foreground">
              {t("auth.upgrade.codeSentTo", "We sent a 6-digit code to")}{" "}
              <span className="font-mono text-foreground">{pendingTarget}</span>
            </p>
            <label className="space-y-2 block">
              <span className="text-[12px] font-medium text-ink-2">
                {t("auth.verifyCode", "Verification code")}
              </span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoFocus
                maxLength={6}
                className="font-mono"
              />
            </label>
            {errorMessage && <p className="text-[12px] text-destructive">{errorMessage}</p>}
            <Button
              type="submit"
              disabled={loading || code.length !== 6}
              className="h-10 w-full bg-coral text-paper hover:bg-coral/90"
            >
              {loading
                ? t("auth.upgrade.verifying", "Verifying…")
                : t("auth.upgrade.confirm", "Confirm and upgrade")}
            </Button>
            <button
              type="button"
              onClick={onUseDifferentTarget}
              className="block w-full text-center text-[12px] text-muted-foreground hover:text-foreground"
            >
              {method === "email"
                ? t("auth.useDifferentEmail", "Use a different email")
                : t("auth.useDifferentPhone", "Use a different phone")}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
