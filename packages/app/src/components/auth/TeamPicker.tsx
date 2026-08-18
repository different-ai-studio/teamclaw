import { useTranslation } from "react-i18next";
import type { MembershipTeam } from "@/lib/backend";
import { TeamChoiceList } from "./TeamChoiceList";

interface TeamPickerProps {
  teams: MembershipTeam[];
  /**
   * The team the user last entered (persisted across logins). Gets a "Last
   * used" badge and the pre-selection highlight. Null on first login (no
   * history) — the first team is highlighted instead, without the badge.
   */
  lastUsedTeamId?: string | null;
  onDone: () => void;
}

/**
 * The login-gate team chooser. Only reached when there is nothing to restore —
 * a first login, or a remembered team the user has since left (see
 * `pickAutoRestoreTarget` in AuthGate). Switching later is Settings → General.
 */
export function TeamPicker({ teams, lastUsedTeamId, onDone }: TeamPickerProps) {
  const { t } = useTranslation();
  const memberTeamCount = teams.filter((team) => team.isMember !== false).length;

  return (
    <div
      className="flex h-screen items-center justify-center bg-background px-6"
      data-tauri-drag-region
    >
      <div className="max-h-[calc(100vh-48px)] w-full max-w-[440px] overflow-y-auto rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">
          {t("teamPicker.title", "Choose a team")}
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          {memberTeamCount > 1
            ? t("teamPicker.subtitle", "You belong to multiple teams. Pick one to continue.")
            : t("teamPicker.subtitleSingle", "Pick a team to continue.")}
        </p>

        <TeamChoiceList teams={teams} lastUsedTeamId={lastUsedTeamId} onDone={onDone} />
      </div>
    </div>
  );
}
