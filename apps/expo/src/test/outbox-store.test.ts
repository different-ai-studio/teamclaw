import { afterEach, describe, expect, it } from "vitest";

import {
  getOutboxSnapshot,
  resetOutbox,
  setOutboxStatus,
} from "../features/sessions/outbox-store";

describe("outbox-store", () => {
  afterEach(() => {
    resetOutbox();
  });

  it("returns the same snapshot reference when state has not changed", () => {
    const first = getOutboxSnapshot();
    const second = getOutboxSnapshot();

    expect(second).toBe(first);

    setOutboxStatus("message-1", "sending");
    const afterChange = getOutboxSnapshot();

    expect(afterChange).not.toBe(first);
    expect(getOutboxSnapshot()).toBe(afterChange);
  });
});
