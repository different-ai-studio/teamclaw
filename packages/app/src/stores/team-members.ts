// packages/app/src/stores/team-members.ts
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { TeamMember } from '../lib/git/types'

type MemberRole = 'owner' | 'editor' | 'viewer'

interface TeamApplication {
  nodeId: string
  name: string
  email: string
  note: string
  platform: string
  arch: string
  hostname: string
  appliedAt: string
}

interface TeamMembersState {
  members: TeamMember[]
  myRole: MemberRole | null
  loading: boolean
  error: string | null
  applications: TeamApplication[]
  _unlistenApplications: (() => void) | null
  /** This device's P2P node ID, loaded once and shared across components. */
  currentNodeId: string | null

  loadMembers: () => Promise<void>
  loadMyRole: () => Promise<void>
  loadCurrentNodeId: () => Promise<void>
  addMember: (member: TeamMember) => Promise<void>
  removeMember: (nodeId: string) => Promise<void>
  updateMemberRole: (nodeId: string, role: MemberRole) => Promise<void>
  canManageMembers: () => boolean
  approveApplication: (app: TeamApplication) => Promise<void>
  listenForApplications: () => Promise<void>
  cleanupApplicationsListener: () => void
  reset: () => void
}

export const useTeamMembersStore = create<TeamMembersState>((set, get) => ({
  members: [],
  myRole: null,
  loading: false,
  error: null,
  applications: [],
  _unlistenApplications: null,
  currentNodeId: null,

  loadCurrentNodeId: async () => {
    if (get().currentNodeId) return
    try {
      const info = await invoke<{ nodeId: string }>('get_device_info')
      set({ currentNodeId: info.nodeId })
    } catch {
      // P2P node not running yet — will retry next call
    }
  },

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

  listenForApplications: async () => {
    // Prevent duplicate listeners
    const state = get()
    if (state._unlistenApplications) return

    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen<TeamApplication[]>('oss-applications-updated', (event) => {
      set({ applications: event.payload })
    })
    set({ _unlistenApplications: unlisten })
  },

  cleanupApplicationsListener: () => {
    const { _unlistenApplications } = get()
    if (_unlistenApplications) {
      _unlistenApplications()
      set({ _unlistenApplications: null })
    }
  },

  reset: () => {
    const { _unlistenApplications } = get()
    if (_unlistenApplications) {
      _unlistenApplications()
    }
    set({
      members: [],
      myRole: null,
      loading: false,
      error: null,
      applications: [],
      _unlistenApplications: null,
    })
  },

  approveApplication: async (app) => {
    try {
      await invoke('oss_approve_application', {
        nodeId: app.nodeId,
        name: app.name,
        email: app.email,
        role: 'editor',
      })
      // Remove from local list
      set((state) => ({
        applications: state.applications.filter((a) => a.nodeId !== app.nodeId),
      }))
      // Reload members to reflect the new member
      get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
    }
  },
}))
