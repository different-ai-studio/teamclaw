import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { supabase } from "@/lib/supabase-client";
import { isTauri } from "@/lib/utils";
import { generateRandomTeamName } from "@/lib/random-team-name";
import { LoginScreen } from "./LoginScreen";
import { LobsterLoader } from "./LobsterLoader";

interface AuthGateProps {
  children: React.ReactNode;
}

type BootstrapState = "idle" | "checking" | "ready";

export function AuthGate({ children }: AuthGateProps) {
  const { t } = useTranslation();
  const { session, loading, hydrate } = useAuthStore();
  const [bootstrap, setBootstrap] = useState<BootstrapState>("idle");
  const bootstrappedUserId = useRef<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    document.getElementById("skeleton")?.remove();
  }, []);

  // After auth: ensure the user belongs to at least one team. If not (fresh
  // signup, no invites), auto-create a temporary team so the UI lands
  // somewhere usable instead of an empty shell. Tauri-only for now.
  //
  // The ref guard (instead of a cleanup-driven `cancelled` flag) is
  // deliberate: under React strict mode the effect runs twice, and a
  // cancelled-flag pattern would mark the in-flight request as discarded
  // and leave bootstrap pinned at "checking" forever.
  useEffect(() => {
    if (!session) {
      bootstrappedUserId.current = null;
      setBootstrap("idle");
      return;
    }
    if (!isTauri()) {
      setBootstrap("ready");
      return;
    }
    if (bootstrappedUserId.current === session.user.id) return;
    bootstrappedUserId.current = session.user.id;
    setBootstrap("checking");

    void (async () => {
      try {
        // RLS on `teams` restricts select to teams the user is a member of,
        // so a non-empty result means they already have somewhere to land.
        const { data: teams, error } = await supabase
          .from("teams")
          .select("id")
          .limit(1);
        if (error) {
          console.warn("[AuthGate] team lookup failed", error);
          return;
        }
        if (teams && teams.length > 0) {
          return;
        }

        const name = generateRandomTeamName();
        const { error: createErr } = await supabase.rpc("create_team", {
          p_name: name,
        });
        if (createErr) {
          console.warn("[AuthGate] auto create_team failed", createErr);
        } else {
          console.log("[AuthGate] auto-created team", name);
        }
      } catch (err) {
        console.warn("[AuthGate] team bootstrap threw", err);
      } finally {
        setBootstrap("ready");
      }
    })();
  }, [session]);

  if (loading && !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background">
        <LobsterLoader size={120} />
        <p className="text-[13px] text-muted-foreground">{t("auth.loading", "Loading…")}</p>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  if (isTauri() && bootstrap !== "ready") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background">
        <LobsterLoader size={120} />
        <p className="text-[13px] text-muted-foreground">
          {t("auth.settingUpWorkspace", "Setting up your workspace…")}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
