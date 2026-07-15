export type IdeaStatus = "open" | "in_progress" | "done";

export type Idea = {
  ideaId: string;
  teamId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  createdByActorId: string | null;
  title: string;
  description: string;
  status: IdeaStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type IdeasListState = {
  status: "idle" | "loading" | "error" | "ready";
  ideas: Idea[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
};

export const initialIdeasListState: IdeasListState = {
  status: "idle",
  ideas: [],
  isLoading: false,
  isRefreshing: false,
  errorMessage: null,
};

export function isOpenIdea(idea: Idea): boolean {
  return idea.status === "open";
}

export function isDoneIdea(idea: Idea): boolean {
  return idea.status === "done";
}

export function isMineIdea(idea: Idea, actorId: string | null): boolean {
  if (!actorId) return false;
  return idea.createdByActorId === actorId;
}
