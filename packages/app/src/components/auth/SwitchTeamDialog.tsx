import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getBackend } from "@/lib/backend";
import type { MembershipTeam } from "@/lib/backend";
import { useCurrentTeamStore } from "@/stores/current-team";
import { TeamChoiceList } from "./TeamChoiceList";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Switch teams from inside the app.
 *
 * The login gate now restores the last team instead of asking every launch, so
 * without this the only way out of a team would be signing out. Same listing
 * and same entry path as the gate (`TeamChoiceList` → join if needed, then
 * `switchToTeam`, which activates the org and rebinds the daemon).
 */
export function SwitchTeamDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null);
  const [teams, setTeams] = useState<MembershipTeam[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load on open rather than on mount: memberships change out of band (invites,
  // someone publishing a team) and a settings pane can stay mounted for hours.
  useEffect(() => {
    if (!open) {
      setTeams(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await getBackend().teams.listAllMyTeams();
        if (!cancelled) setTeams(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-96px)] overflow-y-auto sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("settings.general.switchTeam", "Switch team")}</DialogTitle>
          <DialogDescription>
            {t(
              "settings.general.switchTeamDesc",
              "Pick the team to work in. The app reopens in it and remembers the choice.",
            )}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-[11.5px] leading-4 text-coral"
          >
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}

        {teams === null && !error ? (
          <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("common.loading", "Loading…")}
          </div>
        ) : null}

        {teams !== null && (
          <TeamChoiceList
            teams={teams}
            currentTeamId={currentTeamId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
