import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore, setLocalCacheTeamGate, readCachedCurrentTeam } from "@/stores/current-team";
import { getBackend } from "@/lib/backend";
import { isTauri, removeStartupSkeleton } from "@/lib/utils";
import { devSkipDaemonOnboarding, devSkipSetup } from "@/lib/dev-onboarding-flags";
import { resolveDefaultDisplayName } from "@/lib/default-display-name";
import { DesktopOnboarding } from "./DesktopOnboarding";
import { LoginScreen } from "./LoginScreen";
import { SetupWizard } from "@/components/auth/SetupWizard";
import { useSetupStore, setupPreviouslySatisfied } from "@/stores/setup";
import { DaemonOnboardingWizard } from "@/components/auth/DaemonOnboardingWizard";
import { TeamBootstrapErrorScreen } from "@/components/auth/TeamBootstrapErrorScreen";
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";
import { refreshSession } from "@/lib/auth";
import { CloudApiError } from "@/lib/backend/cloud-api/http";
import { humanizeFcError } from "@/lib/fc-error";
import { markStartup } from "@/lib/startup-perf";
import { TeamPicker } from "./TeamPicker";
import { PendingInvitesDialog } from "@/components/auth/PendingInvitesDialog";
import type { MembershipTeam } from "@/lib/backend";

interface AuthGateProps {
  children: React.ReactNode;
}

type BootstrapState = "idle" | "checking" | "ready" | "error";

export function AuthGate({ children }: AuthGateProps) {
  const { session, loading, authFlow, hydrate, signOut } = useAuthStore();
  const [bootstrap, setBootstrap] = useState<BootstrapState>("idle");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [authHydrated, setAuthHydrated] = useState(false);
  const bootstrappedUserId = useRef<string | null>(null);

  const setupLoaded = useSetupStore((s) => s.loaded);
  const setupRequiredSatisfied = useSetupStore((s) => s.requiredSatisfied());
  const listSetup = useSetupStore((s) => s.listRequirements);
  // Optimistic skip: if a prior launch confirmed all required deps, don't gate
  // first paint behind the cold `setup_list_requirements` probe (~4s on macOS
  // first launch — it spawns `amuxd doctor`). The probe still runs in the
  // background (effect below) to refresh the cache, and the daemon-onboarding
  // gate is the real backstop if a dependency actually went missing.
  const [setupAck, setSetupAck] = useState(() => devSkipSetup() || setupPreviouslySatisfied());

  const daemonStatus = useDaemonOnboardingStore((s) => s.status);
  const daemonLoaded = useDaemonOnboardingStore((s) => s.loaded);
  const refreshDaemonOnboarding = useDaemonOnboardingStore((s) => s.refresh);
  const [daemonOnboardingAck, setDaemonOnboardingAck] = useState(() => devSkipDaemonOnboarding());

  // Multi-team (cross-org) picker: shown on EVERY login when the user belongs to
  // 2+ teams so they can choose which one to enter. `teamChosen` marks "already
  // picked this session" so it doesn't re-open after selection; both reset on a
  // new session (login). Applies on web and Tauri alike (multi-team is backend-
  // driven, not platform-specific).
  const [myTeams, setMyTeams] = useState<MembershipTeam[] | null>(null);
  const [teamChosen, setTeamChosen] = useState(false);
  // The team this user last entered (persisted from a prior session). Captured
  // before team-bootstrap can overwrite the cache, so the picker can badge it
  // "Last used". Null on a genuinely-first login (no history).
  const [lastUsedTeamId, setLastUsedTeamId] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri()) void listSetup();
  }, [listSetup]);

  // Re-evaluate the picker on every login: clear the pick flag + cached list
  // whenever the signed-in user changes.
  useEffect(() => {
    setTeamChosen(false);
    setMyTeams(null);
    // Capture the genuine last-used team (persisted by a prior session) NOW,
    // before the team-bootstrap effect below adopts a team and overwrites the
    // cache. Guard on teamUserId so one user's cache never leaks into another's.
    const cached = readCachedCurrentTeam();
    setLastUsedTeamId(
      cached && cached.teamUserId === session?.user?.id ? cached.team?.id ?? null : null,
    );
  }, [session?.user?.id]);

  // After login + team-bootstrap ready, fetch "all my teams (across orgs)" to
  // decide whether to show the picker. A fetch failure must not block login:
  // treat it as "no picker needed" and fall through.
  useEffect(() => {
    if (!session || bootstrap !== "ready" || teamChosen) return;
    let cancelled = false;
    void (async () => {
      try {
        const teams = await getBackend().teams.listAllMyTeams();
        if (!cancelled) setMyTeams(teams);
      } catch (e) {
        console.warn("[AuthGate] listAllMyTeams failed", e);
        if (!cancelled) setMyTeams([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, bootstrap, teamChosen]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(hydrate()).finally(() => {
      if (!cancelled) setAuthHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    markStartup("authgate:mount");
  }, []);

  useEffect(() => {
    if (isTauri() && session && bootstrap === "ready") void refreshDaemonOnboarding()
  }, [session, bootstrap, refreshDaemonOnboarding]);

  // Claim a stashed invite once the user signs in with a REAL (non-anonymous)
  // account. Member invites can't be claimed anonymously (enforced server-side
  // in claim_team_invite), so the onboarding stashes the token and routes the
  // user through sign-in; this completes the join afterward.
  const pendingInviteToken = useAuthStore((s) => s.pendingInviteToken);
  useEffect(() => {
    if (!session || session.user?.is_anonymous) return;
    if (!pendingInviteToken) return;
    void useAuthStore.getState().claimPendingInvite();
  }, [session, pendingInviteToken]);

  // Separate from the token replay above: these invites were addressed to the
  // user's verified email/phone and matched server-side, so the user never had
  // a link. Skipped while a token claim is queued — that invite is the one the
  // user actually acted on, and joining it may satisfy the pending list anyway.
  useEffect(() => {
    if (!session || session.user?.is_anonymous) return;
    if (pendingInviteToken) return;
    void useAuthStore.getState().refreshPendingInvites();
  }, [session, pendingInviteToken]);

  // After auth: ensure the user belongs to at least one team. If not (fresh
  // signup, no invites), auto-create a temporary team so the UI lands
  // somewhere usable instead of an empty shell. Tauri-only for now.
  //
  // The ref guard (instead of a cleanup-driven `cancelled` flag) is
  // deliberate: under React strict mode the effect runs twice, and a
  // cancelled-flag pattern would mark the in-flight request as discarded
  // and leave bootstrap pinned at "checking" forever.
  useEffect(() => {
    if (loading) return;
    if (!session) {
      bootstrappedUserId.current = null;
      setBootstrap("idle");
      setBootstrapError(null);
      setRetrying(false);
      return;
    }
    // Browser runtime (Chrome extension / web build) is a real cloud client:
    // it still needs a current team for MQTT + team-scoped reads, so it must
    // run the same team-bootstrap as desktop. The bootstrap path below is
    // browser-safe (Cloud API + try/catch-guarded local cache). Only the
    // desktop-specific setup/daemon gates remain isTauri()-fenced (below).
    if (bootstrappedUserId.current === session.user.id) return;
    bootstrappedUserId.current = session.user.id;
    markStartup("team-bootstrap:start");

    // Optimistic cold start: if we already hold a team for THIS user — hydrated
    // synchronously from the persisted cache, or just set by an invite flow —
    // render the shell immediately instead of blocking first paint behind the
    // team-bootstrap network round-trips. App's mount-time load() revalidates
    // and reconciles in the background. The teamUserId match is mandatory: a
    // cached team from a previous user (localStorage survives logout) must NOT
    // be reused; that session falls through to a full re-resolve below.
    const snapshot = useCurrentTeamStore.getState();
    if (snapshot.team && snapshot.teamUserId === session.user.id) {
      // Prime the backend's team gate so the team-scoped session-cache reads
      // App fires on mount are accepted (cold path used to set this during
      // bootstrap, before App mounted). Fire-and-forget: the IPC is fast and
      // App's load() re-sets it shortly after anyway.
      void setLocalCacheTeamGate(snapshot.team.id);
      setBootstrap("ready");
      markStartup("team-bootstrap:end");
      return;
    }

    setBootstrap("checking");

    void (async () => {
      let teamSet = false;
      let bootErr: unknown = null;
      try {
        const teams = await getBackend().teams.listCurrentUserTeams({ limit: 1 });
        markStartup("team-list:end");
        // The list row already carries {id,name,slug}, so adopt it directly via
        // setActiveTeam instead of reloadAndSwitchTo — the latter re-fetches the
        // same team with a redundant GET /v1/teams/:id on the critical path.
        const existing = teams[0];
        if (existing) {
          await useCurrentTeamStore.getState().setActiveTeam({
            id: existing.id,
            name: existing.name,
            slug: existing.slug ?? "",
          });
          teamSet = true;
        } else {
          // Current-org listing can be empty while the user still belongs to
          // teams in other orgs (JWT org drift, multi-org membership). Calling
          // create_team in that case fails with "first-team onboarding only".
          const allTeams = await getBackend().teams.listAllMyTeams();
          if (allTeams.length > 0) {
            const cached = readCachedCurrentTeam();
            const preferredId =
              cached && cached.teamUserId === session.user.id ? cached.team?.id : null;
            const pick =
              (preferredId
                ? allTeams.find((t) => t.id === preferredId)
                : undefined) ?? allTeams[0];
            await useCurrentTeamStore.getState().switchToTeam(pick.id);
            teamSet = true;
          } else {
          // First-team onboarding: let the server seed the names from the
          // caller's org. The team adopts the org's name, and the owner actor
          // adopts the account's nickname (saas-mono mirror). We only fall back
          // to a client-resolved display name (OS full name / email prefix) so a
          // nickname-less account doesn't land as a synthesized handle; the
          // server still prefers the nickname when present.
          const displayName = await resolveDefaultDisplayName(session?.user?.email);
          const created = await getBackend().teams.createTeam({ displayName });
          if (created?.id) {
            await useCurrentTeamStore.getState().setActiveTeam({
              id: created.id,
              name: created.name,
              slug: created.slug ?? "",
            });
            teamSet = true;
            console.log("[AuthGate] auto-created team", created.name);
          } else {
            bootErr = new Error("create_team returned no team id");
          }
          }
        }
      } catch (err) {
        if (err instanceof CloudApiError && err.status === 401) {
          try {
            await refreshSession();
            bootstrappedUserId.current = null;
            setBootstrapNonce((n) => n + 1);
            setRetrying(false);
            return;
          } catch (refreshErr) {
            console.warn("[AuthGate] auth rejected, signing out", refreshErr);
            await signOut();
            return;
          }
        }
        bootErr = err;
        console.warn("[AuthGate] team bootstrap failed", err);
      }
      markStartup("team-bootstrap:end");
      setRetrying(false);
      if (teamSet) {
        setBootstrapError(null);
        setBootstrap("ready");
      } else {
        // No current team means the app can't continue — daemon onboarding,
        // sessions and the actor directory are all team-scoped. Surface the
        // failure with a retry instead of silently dropping into an empty,
        // half-broken shell (the previous behavior swallowed this error).
        setBootstrapError(humanizeFcError(bootErr));
        setBootstrap("error");
      }
    })();
  }, [loading, session, bootstrapNonce]);

  const retryBootstrap = () => {
    // Re-arm the per-user ref guard and bump the nonce so the bootstrap effect
    // runs again. `retrying` keeps the error screen up (with a spinner) instead
    // of flashing back to the skeleton while the retry is in flight.
    bootstrappedUserId.current = null;
    setRetrying(true);
    setBootstrapNonce((n) => n + 1);
  };

  // Each gate below either (a) is a pure-loading state — return null so the
  // static #skeleton (z-9999, mirrors the real shell) keeps showing through an
  // empty #root, no blank flash; or (b) renders real/interactive UI — tear the
  // skeleton down first so the screen is visible and clickable. The happy path
  // (children) deliberately does NOT remove the skeleton here: App removes it
  // once the workspace resolves, so the hand-off goes skeleton → real UI with
  // no intermediate spinner.

  // First-run: in Tauri, ensure local prerequisites (amuxd/opencode) before auth.
  if (isTauri() && !setupAck) {
    if (!setupLoaded) {
      return null;
    }
    if (!setupRequiredSatisfied) {
      removeStartupSkeleton();
      return <SetupWizard onDone={() => setSetupAck(true)} />;
    }
  }

  if (isTauri() && loading && authFlow === "invite") {
    removeStartupSkeleton();
    return <DesktopOnboarding />;
  }

  if (!authHydrated && loading) {
    return null;
  }

  if (!session) {
    removeStartupSkeleton();
    return isTauri() ? <DesktopOnboarding /> : <LoginScreen />;
  }

  if (loading) {
    return null;
  }

  // Team bootstrap failed (e.g. createTeam rejected by a drifted backend).
  // Surface it with a retry; `retrying` keeps this up while a retry re-resolves.
  if (isTauri() && (bootstrap === "error" || retrying)) {
    removeStartupSkeleton();
    return (
      <TeamBootstrapErrorScreen
        error={bootstrapError}
        busy={retrying}
        onRetry={retryBootstrap}
        onSignOut={() => void signOut()}
      />
    );
  }

  if (isTauri() && bootstrap !== "ready") {
    return null;
  }

  // Multi-team picker gate: after team-bootstrap, before the daemon gate. If the
  // user belongs to 2+ teams (possibly across orgs) and hasn't picked this
  // session yet, choose a team first. Selecting calls switchToTeam (activates
  // the team server-side, adopts the org-switched JWT, switches current team,
  // and refreshes the daemon) — so the daemon gate below then evaluates against
  // the chosen team and triggers re-onboard on mismatch.
  if (session && bootstrap === "ready" && !teamChosen) {
    if (myTeams === null) {
      return null; // Still loading the team list — keep the skeleton.
    }
    if (myTeams.length >= 2) {
      removeStartupSkeleton();
      return (
        <TeamPicker
          teams={myTeams}
          lastUsedTeamId={lastUsedTeamId}
          onDone={() => setTeamChosen(true)}
        />
      );
    }
  }

  // Daemon readiness gate: after login + workspace bootstrap, ensure the local
  // daemon is bound to the current team AND running with a valid token. Interactive
  // states (needs-onboard / mismatch) prompt the user; transient states (starting /
  // error) auto-recover or offer retry. 'ready'/'unknown' fall through.
  if (isTauri() && !daemonOnboardingAck) {
    if (!daemonLoaded) {
      return null;
    }
    if (
      daemonStatus === 'needs-onboard' ||
      daemonStatus === 'mismatch' ||
      daemonStatus === 'starting' ||
      daemonStatus === 'error'
    ) {
      removeStartupSkeleton();
      return <DaemonOnboardingWizard onDone={() => setDaemonOnboardingAck(true)} />;
    }
  }

  markStartup("authgate:children");
  // Rendered alongside the app rather than as a gate: an unaccepted invite is
  // not a reason to withhold the workspace the user already has.
  return (
    <>
      {children}
      <PendingInvitesDialog />
    </>
  );
}
