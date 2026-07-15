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
import { getBackend } from "@/lib/backend";
import { adoptRefreshToken } from "@/lib/auth";
import { useCurrentTeamStore } from "@/stores/current-team";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Graduate the current account out of the shared default org into its own org:
 * collect an org name + contact, call /v1/account/upgrade (creates the org,
 * reparents + renames the team), then refresh the session so the new org claim
 * applies. See docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md §8.
 */
export function UpgradeToOrgDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [orgName, setOrgName] = useState("");
  const [contact, setContact] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setOrgName("");
      setContact("");
      setError(null);
      setLoading(false);
    }
  }, [open]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const teamId = useCurrentTeamStore.getState().team?.id;
    if (!teamId) {
      setError(t("auth.upgradeOrg.noTeam", "No active team to upgrade."));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await getBackend().teams.upgradeAccount({
        teamId,
        orgName: orgName.trim(),
        contact: contact.trim() || null,
      });
      // The team was reparented to the new org and renamed, and the account's
      // org claim changed — mint a fresh session for the team so the new org_id
      // takes effect, then reload the (renamed) team into the store.
      const act = await getBackend().teams.activateTeam(teamId);
      if (act.refreshToken) await adoptRefreshToken(act.refreshToken);
      await useCurrentTeamStore.getState().reloadAndSwitchTo(teamId);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("auth.upgradeOrg.title", "创建你自己的团队")}</DialogTitle>
          <DialogDescription>
            {t(
              "auth.upgradeOrg.desc",
              "填写团队/组织名称后，我们会把当前团队迁到你自己的组织下，之后即可邀请成员协作。",
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="space-y-2 block">
            <span className="text-[12px] font-medium text-ink-2">
              {t("auth.upgradeOrg.orgName", "团队/组织名称")}
            </span>
            <Input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              autoFocus
              maxLength={60}
              placeholder={t("auth.upgradeOrg.orgNamePlaceholder", "例如：我的攀岩馆")}
            />
          </label>
          <label className="space-y-2 block">
            <span className="text-[12px] font-medium text-ink-2">
              {t("auth.upgradeOrg.contact", "联系方式（选填）")}
            </span>
            <Input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={50}
              placeholder={t("auth.upgradeOrg.contactPlaceholder", "手机号 / 邮箱")}
            />
          </label>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={loading || !orgName.trim()}
            className="h-10 w-full bg-coral text-paper hover:bg-coral/90"
          >
            {loading
              ? t("auth.upgradeOrg.submitting", "创建中…")
              : t("auth.upgradeOrg.submit", "创建并迁移")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
