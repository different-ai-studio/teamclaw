import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/date-format";
import type { MembershipTeam } from "@/lib/backend";
import { getBackend } from "@/lib/backend";
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
  const memberTeamCount = teams.filter((team) => team.isMember !== false).length;

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

  /**
   * Names repeated inside one org group. A team is named after its org and the
   * name is not unique, so an org where several people onboarded ends up with
   * several teams reading identically — without this the rows are two
   * indistinguishable buttons.
   *
   * Scoped per group rather than across the whole list on purpose: two teams
   * with the same name in DIFFERENT orgs are already told apart by the org
   * heading above them, so annotating those would be noise.
   */
  const ambiguousNamesByGroup = new Map<string, Set<string>>();
  for (const [orgName, orgTeams] of groups) {
    const counts = new Map<string, number>();
    for (const team of orgTeams) {
      counts.set(team.name, (counts.get(team.name) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [name, n] of counts) if (n > 1) dupes.add(name);
    ambiguousNamesByGroup.set(orgName, dupes);
  }

  /**
   * The line shown under an ambiguous name: owner, size, age. Each part is
   * dropped when the backend did not supply it, so an older server (or the
   * Postgres backend, which has no org model) degrades to a shorter line rather
   * than rendering "undefined".
   */
  function disambiguation(team: MembershipTeam): string | null {
    const parts: string[] = [];
    if (team.ownerName) parts.push(team.ownerName);
    if (typeof team.memberCount === "number") {
      parts.push(t("teamPicker.memberCount", { count: team.memberCount }));
    }
    if (team.createdAt) parts.push(formatDate(team.createdAt));
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  async function choose(team: MembershipTeam) {
    setError(null);
    setBusyId(team.id);
    try {
      // Public teams in the caller's own org that they haven't joined yet:
      // enroll as a plain member first so switchToTeam (and every team-scoped
      // RPC after it) has membership. Idempotent server-side.
      if (team.isMember === false) {
        await getBackend().teams.joinTeam(team.id);
      }
      await switchToTeam(team.id);
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
      <div className="max-h-[calc(100vh-48px)] w-full max-w-[440px] overflow-y-auto rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">
          {t("teamPicker.title", "Choose a team")}
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          {memberTeamCount > 1
            ? t("teamPicker.subtitle", "You belong to multiple teams. Pick one to continue.")
            : t("teamPicker.subtitleSingle", "Pick a team to continue.")}
        </p>

        {/*
          Strict single-org: entering a team moves the account's active org, and
          teams in the other orgs become unreadable until you switch back. The
          picker lists them all regardless (it is a cross-org listing), so
          without this the choice looks free and is not.
        */}
        {groups.size > 1 && (
          <p className="mt-2 text-[11.5px] leading-4 text-faint">
            {t(
              "teamPicker.singleOrgNotice",
              "You can work in one organization at a time. Choosing a team here leaves the other organizations' teams inaccessible until you switch back.",
            )}
          </p>
        )}

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
                  const joinable = team.isMember === false;
                  const detail = ambiguousNamesByGroup.get(orgName)?.has(team.name)
                    ? disambiguation(team)
                    : null;
                  return (
                    <button
                      key={team.id}
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void choose(team)}
                      className={cn(
                        "group flex items-center justify-between rounded-[12px] border bg-paper px-4 py-3 text-left transition-colors hover:bg-selected disabled:opacity-50",
                        active ? "border-coral" : "border-border",
                      )}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                            {team.name}
                          </span>
                          {isLastUsed && (
                            <span className="shrink-0 rounded-full bg-selected px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {t("teamPicker.lastUsed", "Last used")}
                            </span>
                          )}
                          {joinable && (
                            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-faint">
                              {t("teamPicker.public", "Public")}
                            </span>
                          )}
                        </span>
                        {detail && (
                          <span className="min-w-0 truncate text-[11.5px] leading-4 text-faint">
                            {detail}
                          </span>
                        )}
                      </span>
                      {switching ? (
                        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {joinable
                            ? t("teamPicker.joining", "Joining…")
                            : t("teamPicker.switching", "Switching…")}
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
