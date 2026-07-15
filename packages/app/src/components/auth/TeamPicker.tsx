import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MembershipTeam } from "@/lib/backend";
import { useCurrentTeamStore } from "@/stores/current-team";

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

export function TeamPicker({ teams, lastUsedTeamId, onDone }: TeamPickerProps) {
  const { t } = useTranslation();
  const switchToTeam = useCurrentTeamStore((s) => s.switchToTeam);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Highlight the last-used team; on first login (no history) fall back to the
  // first team so there's always a visible pre-selection.
  const highlightId = lastUsedTeamId ?? teams[0]?.id ?? null;

  // Group by org, preserving first-seen order. Teams without an org name fall
  // into a single "ungrouped" bucket.
  const ungrouped = t("teamPicker.ungrouped", "Other");
  const groups = new Map<string, MembershipTeam[]>();
  for (const team of teams) {
    const key = team.orgName ?? ungrouped;
    const bucket = groups.get(key);
    if (bucket) bucket.push(team);
    else groups.set(key, [team]);
  }

  async function choose(teamId: string) {
    setError(null);
    setBusyId(teamId);
    try {
      await switchToTeam(teamId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyId(null);
    }
  }

  return (
    <div
      className="flex h-screen items-center justify-center bg-background px-6"
      data-tauri-drag-region
    >
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">
          {t("teamPicker.title", "Choose a team")}
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          {t("teamPicker.subtitle", "You belong to multiple teams. Pick one to continue.")}
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 flex items-start gap-1.5 text-[11.5px] leading-4 text-coral"
          >
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}

        <div className="mt-5 flex flex-col gap-5">
          {[...groups.entries()].map(([orgName, orgTeams]) => (
            <div key={orgName} className="flex flex-col gap-2">
              <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
                {orgName}
              </span>
              <div className="flex flex-col gap-2">
                {orgTeams.map((team) => {
                  const active = team.id === highlightId;
                  const isLastUsed = team.id === lastUsedTeamId;
                  const switching = busyId === team.id;
                  return (
                    <button
                      key={team.id}
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void choose(team.id)}
                      className={cn(
                        "group flex items-center justify-between rounded-[12px] border bg-paper px-4 py-3 text-left transition-colors hover:bg-selected disabled:opacity-50",
                        active ? "border-coral" : "border-border",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                          {team.name}
                        </span>
                        {isLastUsed && (
                          <span className="shrink-0 rounded-full bg-selected px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t("teamPicker.lastUsed", "Last used")}
                          </span>
                        )}
                      </span>
                      {switching ? (
                        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("teamPicker.switching", "Switching…")}
                        </span>
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-faint transition-colors group-hover:text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
