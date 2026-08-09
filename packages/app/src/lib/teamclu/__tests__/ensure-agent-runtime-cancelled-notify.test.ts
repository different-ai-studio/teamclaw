import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  reportRuntimeStartFailure: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
}));

vi.mock("@/lib/telemetry/runtime-error-report", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/telemetry/runtime-error-report")
  >();
  return {
    ...actual,
    // Only the reporter is stubbed — `isCancelledRuntimeFailure` stays real, so
    // this exercises the actual classification rather than a copy of it.
    reportRuntimeStartFailure: (...args: unknown[]) =>
      mocks.reportRuntimeStartFailure(...args),
  };
});

/** The toast path is behind a dynamic `import("sonner")`. */
async function flush(): Promise<void> {
  await import("sonner");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("notifyRuntimeStartFailures", () => {
  beforeEach(() => {
    mocks.toastError.mockClear();
    mocks.reportRuntimeStartFailure.mockClear();
  });

  it("does not toast a request we cancelled ourselves", async () => {
    const { notifyRuntimeStartFailures } = await import("../ensure-agent-runtime");

    notifyRuntimeStartFailures(
      [{ agentActorId: "agent-1", code: "runtime_rpc_failed", reason: "rpc disposed" }],
      { trigger: "session_runtime_retry" },
    );
    await flush();

    // Still reported — the startup race stays measurable, just as a warning.
    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("still toasts a genuine runtime failure", async () => {
    const { notifyRuntimeStartFailures } = await import("../ensure-agent-runtime");

    notifyRuntimeStartFailures([
      { agentActorId: "agent-1", code: "runtime_rpc_failed", reason: "rpc timeout after 20000ms" },
    ]);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it("toasts only the real failures in a mixed batch", async () => {
    const { notifyRuntimeStartFailures } = await import("../ensure-agent-runtime");

    notifyRuntimeStartFailures([
      { agentActorId: "agent-1", code: "runtime_rpc_failed", reason: "rpc disposed" },
      { agentActorId: "agent-2", code: "runtime_rpc_failed", reason: "runtimeStart rejected" },
    ]);
    await flush();

    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    const [, options] = mocks.toastError.mock.calls[0] as [string, { id: string }];
    expect(options.id).toBe("runtime-start-failed-agent-2");
  });
});
