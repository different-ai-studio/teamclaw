/**
 * agent-status — the one rule both repo implementations read from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isListableAgentStatus,
  LISTABLE_AGENT_STATUS_OR_FILTER,
  RETIRED_AGENT_STATUSES,
} from "../src/lib/agent-status.js";

test("active agents and non-agent rows are listable", () => {
  assert.equal(isListableAgentStatus("active"), true);
  // Members carry no agent status; a cache row written before the column
  // existed carries none either. Neither may be hidden.
  assert.equal(isListableAgentStatus(null), true);
  assert.equal(isListableAgentStatus(undefined), true);
});

test("retired agents are not listable", () => {
  for (const status of RETIRED_AGENT_STATUSES) {
    assert.equal(isListableAgentStatus(status), false, `${status} must be hidden`);
  }
});

test("the PostgREST filter ANDs the retired checks under one OR branch", () => {
  // A flat or(is.null, neq.disabled, neq.archived) is the bug this guards:
  // a 'disabled' row satisfies neq.archived and would slip through.
  assert.equal(
    LISTABLE_AGENT_STATUS_OR_FILTER,
    "agent_status.is.null,and(agent_status.neq.disabled,agent_status.neq.archived)",
  );
});
