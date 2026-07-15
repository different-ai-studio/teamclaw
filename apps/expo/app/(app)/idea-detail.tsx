import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import type { Idea, IdeaStatus } from "../../src/features/ideas/idea-types";
import { IdeaDetailScreen } from "../../src/features/ideas/screens/IdeaDetailScreen";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { showToast } from "../../src/ui/Toast";

type BusyAction = "toggleStatus" | "archive" | "save" | null;

export default function IdeaDetailRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ ideaId?: string }>();
  const ideaId = typeof params.ideaId === "string" ? params.ideaId : null;
  const teamId = state.currentTeam?.id ?? "";

  const [idea, setIdea] = useState<Idea | null>(null);
  const [creatorName, setCreatorName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [relatedSessions, setRelatedSessions] = useState<
    Array<{ sessionId: string; title: string; lastMessageAt: string }>
  >([]);

  const refresh = useCallback(async () => {
    if (!teamId || !ideaId) return;
    setIsRefreshing(true);
    try {
      const fresh = await createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).listIdeas(teamId);
      const found = fresh.find((row) => row.ideaId === ideaId) ?? null;
      setIdea(found);
    } finally {
      setIsRefreshing(false);
    }
  }, [ideaId, teamId]);

  useEffect(() => {
    if (!teamId || !ideaId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const ideasApi = createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) });
        const actorsApi = createActorsApi({ getAccessToken: supabaseAccessToken(supabase) });
        const [ideas, actors] = await Promise.all([
          ideasApi.listIdeas(teamId),
          actorsApi.listActors(teamId),
        ]);
        if (cancelled) return;
        const found = ideas.find((row) => row.ideaId === ideaId) ?? null;
        setIdea(found);
        if (found?.createdByActorId) {
          const creator = actors.find((row) => row.actorId === found.createdByActorId);
          setCreatorName(creator?.displayName ?? null);
        } else {
          setCreatorName(null);
        }

        const related = await createConfiguredSessionsApi(supabase).listSessionsForIdea(
          teamId,
          ideaId,
          5,
        );
        if (cancelled) return;
        setRelatedSessions(
          related.map((row) => ({
            sessionId: row.sessionId,
            title: row.title ?? "",
            lastMessageAt: row.lastMessageAt ?? "",
          })),
        );
      } catch {
        if (cancelled) return;
        setIdea(null);
        setCreatorName(null);
        setRelatedSessions([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ideaId, teamId]);

  const handleToggleStatus = idea
    ? async () => {
        setBusyAction("toggleStatus");
        const next: IdeaStatus = idea.status === "done" ? "open" : "done";
        try {
          await createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).updateStatus(idea.ideaId, next);
          setIdea({ ...idea, status: next, updatedAt: new Date().toISOString() });
        } catch {
          // Surface via screen busy state release — keep idea as-is.
        } finally {
          setBusyAction(null);
        }
      }
    : undefined;

  const handleSetStatus = idea
    ? async (next: IdeaStatus) => {
        if (next === idea.status) return;
        setBusyAction("toggleStatus");
        try {
          await createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).updateStatus(idea.ideaId, next);
          setIdea({ ...idea, status: next, updatedAt: new Date().toISOString() });
          showToast("success", `Marked ${next.replace("_", " ")}`);
        } catch (err) {
          showToast(
            "error",
            err instanceof Error ? err.message : "Couldn't update status",
          );
        } finally {
          setBusyAction(null);
        }
      }
    : undefined;

  const handleArchive = idea
    ? async () => {
        setBusyAction("archive");
        try {
          await createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).archive(idea.ideaId);
          showToast("success", "Idea archived");
          router.back();
        } catch (err) {
          showToast(
            "error",
            err instanceof Error ? err.message : "Couldn't archive",
          );
          setBusyAction(null);
        }
      }
    : undefined;

  const handleSaveContent = idea
    ? async (patch: { title: string; description: string }) => {
        setBusyAction("save");
        try {
          await createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).updateContent(idea.ideaId, patch);
          setIdea({
            ...idea,
            title: patch.title,
            description: patch.description,
            updatedAt: new Date().toISOString(),
          });
          showToast("success", "Saved");
        } catch (err) {
          showToast(
            "error",
            err instanceof Error ? err.message : "Couldn't save",
          );
        } finally {
          setBusyAction(null);
        }
      }
    : undefined;

  return (
    <IdeaDetailScreen
      busyAction={busyAction}
      creatorName={creatorName}
      idea={idea}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      onArchive={handleArchive}
      onClose={() => router.back()}
      onRefresh={() => {
        void refresh();
      }}
      onSaveContent={handleSaveContent}
      onSelectSession={(sessionId) => router.replace(`/(app)/sessions/${sessionId}`)}
      onSetStatus={handleSetStatus}
      onStartSession={
        idea
          ? () => {
              router.replace(`/(app)/new-session?ideaId=${idea.ideaId}`);
            }
          : undefined
      }
      onToggleStatus={handleToggleStatus}
      relatedSessions={relatedSessions}
    />
  );
}
