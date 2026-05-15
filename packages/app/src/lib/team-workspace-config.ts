import { supabase } from '@/lib/supabase-client'

export interface TeamWorkspaceConfig {
  teamId: string
  gitUrl: string | null
  gitBranch: string | null
  gitToken: string | null
  aiGatewayEndpoint: string | null
  enabled: boolean
  updatedAt: string
}

interface Row {
  team_id: string
  git_url: string | null
  git_branch: string | null
  git_token: string | null
  ai_gateway_endpoint: string | null
  enabled: boolean
  updated_at: string
}

function fromRow(r: Row): TeamWorkspaceConfig {
  return {
    teamId: r.team_id,
    gitUrl: r.git_url,
    gitBranch: r.git_branch,
    gitToken: r.git_token,
    aiGatewayEndpoint: r.ai_gateway_endpoint,
    enabled: r.enabled,
    updatedAt: r.updated_at,
  }
}

export async function getTeamWorkspaceConfig(teamId: string): Promise<TeamWorkspaceConfig | null> {
  const { data, error } = await supabase
    .from('team_workspace_config')
    .select('team_id, git_url, git_branch, git_token, ai_gateway_endpoint, enabled, updated_at')
    .eq('team_id', teamId)
    .maybeSingle()
  if (error) throw new Error(`getTeamWorkspaceConfig failed: ${error.message}`)
  return data ? fromRow(data as Row) : null
}

export async function upsertTeamWorkspaceConfig(input: TeamWorkspaceConfig): Promise<void> {
  const { error } = await supabase.from('team_workspace_config').upsert({
    team_id:             input.teamId,
    git_url:             input.gitUrl,
    git_branch:          input.gitBranch,
    git_token:           input.gitToken,
    ai_gateway_endpoint: input.aiGatewayEndpoint,
    enabled:             input.enabled,
  })
  if (error) throw new Error(`upsertTeamWorkspaceConfig failed: ${error.message}`)
}
