---
name: ai-keys
description: List all AI API keys for the current team. Shows key aliases, masked key values, and spend per key. Use when a team member asks about their API key or wants to see who has access.
---

# AI Keys

List all AI API keys for the current team via the FC `/ai/keys` endpoint.

## Prerequisites

- Must be in an active OSS team (team_id and team_secret available in local config)
- Team must have been set up with LiteLLM (`/ai/setup-team` called during team creation)

## Usage

Read the team config from `.teamclaw/teamclaw.json` to get `oss.team_id` and `oss.team_endpoint`, then load the team secret from the system keyring.

```bash
# Read team config
TEAM_ID=$(cat .teamclaw/teamclaw.json | jq -r '.oss.team_id')
TEAM_ENDPOINT=$(cat .teamclaw/teamclaw.json | jq -r '.oss.team_endpoint')

# The team secret is stored in the system keyring under service "teamclaw-team" account "{team_id}"
# It should be retrieved programmatically by the client

curl -s -X POST "${TEAM_ENDPOINT}/ai/keys" \
  -H "Content-Type: application/json" \
  -d "{\"teamId\": \"${TEAM_ID}\", \"teamSecret\": \"${TEAM_SECRET}\"}"
```

## Response Format

```json
{
  "teamId": "tc-abc123",
  "keys": [
    {
      "key": "sk-tc-abcd...",
      "alias": "alice-abcdef01",
      "spend": 0.0387,
      "created_at": "2026-03-25T12:00:00Z"
    }
  ]
}
```

## Output

Present the keys in a readable table format:

| Member | Key (masked) | Spend |
|--------|-------------|-------|
| alias  | sk-tc-xxxx... | $0.04 |
