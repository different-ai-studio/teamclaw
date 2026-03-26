---
name: ai-manage
description: Manage AI API keys and budget for the current team. Owner-only operations include adding/removing member keys and setting budget limits. Use when the team owner wants to manage AI access.
---

# AI Manage

Manage AI API keys and team budget via FC endpoints. Most operations require team owner permissions.

## Prerequisites

- Must be in an active OSS team
- Team must have been set up with LiteLLM
- Owner operations require the owner's node_id

## Operations

### Add a member's API key

Creates a LiteLLM API key for a team member using their node_id. This is normally done automatically when a member joins, but can be triggered manually.

```bash
TEAM_ID=$(cat .teamclaw/teamclaw.json | jq -r '.oss.team_id')
TEAM_ENDPOINT=$(cat .teamclaw/teamclaw.json | jq -r '.oss.team_endpoint')

curl -s -X POST "${TEAM_ENDPOINT}/ai/add-member" \
  -H "Content-Type: application/json" \
  -d "{
    \"teamId\": \"${TEAM_ID}\",
    \"teamSecret\": \"${TEAM_SECRET}\",
    \"nodeId\": \"<member-node-id>\",
    \"memberName\": \"Alice\"
  }"
```

Returns: `{ "success": true, "key": "sk-tc-...", "keyAlias": "Alice-abcdef01" }`

### Remove a member's API key (owner only)

```bash
curl -s -X POST "${TEAM_ENDPOINT}/ai/remove-member" \
  -H "Content-Type: application/json" \
  -d "{
    \"teamId\": \"${TEAM_ID}\",
    \"teamSecret\": \"${TEAM_SECRET}\",
    \"ownerNodeId\": \"<owner-node-id>\",
    \"nodeId\": \"<member-node-id>\"
  }"
```

### Set team budget (owner only)

Sets a maximum budget in USD for the team. Once reached, all API calls will be rejected.

```bash
curl -s -X POST "${TEAM_ENDPOINT}/ai/budget" \
  -H "Content-Type: application/json" \
  -d "{
    \"teamId\": \"${TEAM_ID}\",
    \"teamSecret\": \"${TEAM_SECRET}\",
    \"ownerNodeId\": \"<owner-node-id>\",
    \"maxBudget\": 50
  }"
```

Returns: `{ "success": true, "maxBudget": 50 }`

## Notes

- The member's API key format is `sk-tc-{first 40 chars of node_id}`
- The LiteLLM team ID format is `tc-{teamId}`
- Keys are automatically created during team join if `/ai/add-member` is called from the client
- Budget is per-team, not per-member
