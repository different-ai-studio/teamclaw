import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getBackend } from "@/lib/backend";
import type { MembershipTeam } from "@/lib/backend";

export function GuestTeamDiscovery({ onSignIn }: { onSignIn: () => void }) {
  const [teams, setTeams] = useState<MembershipTeam[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void getBackend().teams.listDiscoverableTeams()
      .then((items) => { if (!disposed) setTeams(items); })
      .catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6" data-tauri-drag-region>
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">Browse public teams</h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          Sign in to join a team or accept a member invitation. Guest browsing never creates an actor.
        </p>
        <div className="mt-5 flex max-h-[280px] flex-col gap-2 overflow-y-auto">
          {teams === null && !error && <Loader2 className="h-4 w-4 animate-spin text-faint" />}
          {teams?.map((team) => (
            <div key={team.id} className="rounded-[8px] border border-border px-3 py-2">
              <div className="text-[13px] font-medium text-foreground">{team.name}</div>
              {team.orgName && <div className="mt-0.5 text-[11.5px] text-faint">{team.orgName}</div>}
            </div>
          ))}
          {teams?.length === 0 && <p className="text-[12px] text-faint">No public teams yet.</p>}
          {error && <p className="text-[12px] text-coral">{error}</p>}
        </div>
        <button type="button" onClick={onSignIn} className="mt-5 w-full rounded-[8px] bg-coral px-4 py-2 text-[13px] font-semibold text-white">
          Sign in to continue
        </button>
      </div>
    </div>
  );
}
