import * as React from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useAuthStore } from "@/stores/auth-store";

export function TeamNameCard() {
  const { t } = useTranslation();
  const session = useAuthStore((s) => s.session);
  const team = useCurrentTeamStore((s) => s.team);
  const loading = useCurrentTeamStore((s) => s.loading);
  const saving = useCurrentTeamStore((s) => s.saving);
  const error = useCurrentTeamStore((s) => s.error);
  const load = useCurrentTeamStore((s) => s.load);
  const rename = useCurrentTeamStore((s) => s.rename);

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  React.useEffect(() => {
    if (session) {
      void load();
    }
  }, [session, load]);

  const startEdit = () => {
    setDraft(team?.name ?? "");
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };

  const saveEdit = async () => {
    if (!draft.trim() || draft.trim() === team?.name) {
      cancelEdit();
      return;
    }
    const ok = await rename(draft);
    if (ok) setEditing(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-paper p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-faint">
            {t("settings.team.currentTeam", "Current team")}
          </p>
          {editing ? (
            <div className="mt-2 flex items-center gap-2">
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={80}
                disabled={saving}
                className="h-9 max-w-xs"
                placeholder={t("settings.team.teamNamePlaceholder", "Team name")}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void saveEdit()}
                disabled={saving || !draft.trim()}
                aria-label={t("common.save", "Save")}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={cancelEdit}
                disabled={saving}
                aria-label={t("common.cancel", "Cancel")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <h4 className="truncate text-[18px] font-semibold text-foreground">
                {loading && !team
                  ? t("common.loading", "Loading…")
                  : team?.name ?? t("settings.team.noTeam", "No team")}
              </h4>
              {team && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={startEdit}
                  aria-label={t("common.rename", "Rename")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
          {team?.slug && !editing && (
            <p className="mt-1 font-mono text-[11px] text-faint">{team.slug}</p>
          )}
          {error && (
            <p className="mt-2 text-[12px] text-destructive">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
