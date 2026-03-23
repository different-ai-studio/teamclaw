// packages/app/src/stores/team-members.ts
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { TeamMember } from '../lib/git/types'

type MemberRole = 'owner' | 'editor' | 'viewer'

interface TeamMembersState {
  members: TeamMember[]
  myRole: MemberRole | null
  loading: boolean
  error: string | null

  loadMembers: () => Promise<void>
  loadMyRole: () => Promise<void>
  addMember: (member: TeamMember) => Promise<void>
  removeMember: (nodeId: string) => Promise<void>
  updateMemberRole: (nodeId: string, role: MemberRole) => Promise<void>
  canManageMembers: () => boolean
}

export const useTeamMembersStore = create<TeamMembersState>((set, get) => ({
  members: [],
  myRole: null,
  loading: false,
  error: null,

  loadMembers: async () => {
    set({ loading: true, error: null })
    try {
      const members = await invoke<TeamMember[]>('unified_team_get_members')
      set({ members, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadMyRole: async () => {
    try {
      const role = await invoke<MemberRole | null>('unified_team_get_my_role')
      set({ myRole: role })
    } catch {
      set({ myRole: null })
    }
  },

  addMember: async (member: TeamMember) => {
    set({ error: null })
    try {
      await invoke('unified_team_add_member', { member })
      await get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  removeMember: async (nodeId: string) => {
    set({ error: null })
    try {
      await invoke('unified_team_remove_member', { nodeId })
      await get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  updateMemberRole: async (nodeId: string, role: MemberRole) => {
    set({ error: null })
    try {
      await invoke('unified_team_update_member_role', { nodeId, role })
      await get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  canManageMembers: () => {
    const { myRole } = get()
    return myRole === 'owner' || myRole === 'editor'
  },
}))
