---
name: ai-usage
description: Check AI usage and spend for the current team or individual member. Shows total spend, per-member breakdown, or personal usage. Use when someone asks about costs, budget, or how much has been used.
---

# AI Usage

Query AI usage and spend via the FC `/ai/usage` endpoint.

## Prerequisites

- Must be in an active OSS team
- Team must have been set up with LiteLLM

## How to get parameters

All parameters can be read from local config. The user does NOT need to provide anything manually.

```bash
TEAM_ID=$(cat .teamclaw/teamclaw.json | jq -r '.oss.team_id')
TEAM_ENDPOINT=$(cat .teamclaw/teamclaw.json | jq -r '.oss.team_endpoint')
# node_id is the local device's P2P identity, available via the Tauri command get_node_id
# team_secret is in the system keyring under service "teamclaw-team" account "{team_id}"
```

## View your own usage

Automatically includes the local `nodeId` so the user sees their own spend:

```bash
curl -s -X POST "${TEAM_ENDPOINT}/ai/usage" \
  -H "Content-Type: application/json" \
  -d "{\"teamId\": \"${TEAM_ID}\", \"teamSecret\": \"${TEAM_SECRET}\", \"nodeId\": \"${NODE_ID}\"}"
```

Response:
```json
{
  "teamId": "tc-abc123",
  "nodeId": "abcdef...",
  "spend": 0.0387,
  "maxBudget": null,
  "keyAlias": "alice-abcdef01"
}
```

## View team-wide usage (all members)

Omit `nodeId` to get the full team breakdown:

```bash
curl -s -X POST "${TEAM_ENDPOINT}/ai/usage" \
  -H "Content-Type: application/json" \
  -d "{\"teamId\": \"${TEAM_ID}\", \"teamSecret\": \"${TEAM_SECRET}\"}"
```

Response:
```json
{
  "teamId": "tc-abc123",
  "totalSpend": 1.23,
  "members": [
    { "alias": "alice-abcdef01", "spend": 0.80 },
    { "alias": "bob-12345678", "spend": 0.43 }
  ]
}
```

## Notes

- Default time range is last 30 days. Add `startDate` / `endDate` (YYYY-MM-DD) to filter.
- When the user asks "how much have I used", always pass their nodeId for personal view.
- When the user asks "team usage" or "everyone's usage", omit nodeId for the team-wide view.
