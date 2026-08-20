import { create } from 'zustand'
import { useCurrentTeamStore } from '@/stores/current-team'
import type { IdeaRow } from '@/components/panel/IdeasView'

/**
 * What the main content column shows while the Ideas section is active.
 * Mirrors team-share's `detailTarget`: ideas never create tabs — the one
 * selected view renders directly beside the list column.
 */
export type IdeaDetailTarget =
  /** The compose surface for a new idea. Carries the team resolved by the list. */
  | { kind: 'create'; teamId: string }
  /** One idea open for viewing/editing. The row is a fallback while detail loads. */
  | { kind: 'edit'; idea: IdeaRow }

interface IdeaDetailState {
  target: IdeaDetailTarget | null
  /** Bumped after any pane-side mutation so the list column refetches. */
  mutationTick: number
  openCreate: (teamId: string) => void
  openEdit: (idea: IdeaRow) => void
  clearDetail: () => void
  notifyMutated: () => void
}

export const useIdeaDetailStore = create<IdeaDetailState>((set) => ({
  target: null,
  mutationTick: 0,
  openCreate: (teamId) => set({ target: { kind: 'create', teamId } }),
  openEdit: (idea) => set({ target: { kind: 'edit', idea } }),
  clearDetail: () => set({ target: null }),
  notifyMutated: () => set((s) => ({ mutationTick: s.mutationTick + 1 })),
}))

// An open idea belongs to a team; switching teams must not leave it showing.
useCurrentTeamStore.subscribe((state, prev) => {
  if (state.team?.id !== prev.team?.id) {
    useIdeaDetailStore.getState().clearDetail()
  }
})
