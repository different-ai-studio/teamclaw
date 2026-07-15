import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useSessionStore } from "@/stores/session";
import { resetSessionPermissionModesForTests } from "@/lib/session-permission-mode";
import { ComposerStack } from "../ComposerStack";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const template = fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
        String(options?.[token] ?? `{{${token}}}`),
      );
    },
  }),
}));

vi.mock("@/hooks/useActorDisplayName", () => ({
  useActorDisplayName: (actorId: string) => `Agent-${actorId}`,
}));

describe("ComposerStack", () => {
  beforeEach(() => {
    resetSessionPermissionModesForTests();
    useSessionStore.setState({
      activeSessionId: "sess-1",
      sessions: [{ id: "sess-1", messages: [] }],
      pendingPermissions: [],
      replyPermission: vi.fn(() => Promise.resolve()),
    });
  });

  it("renders a single unified shell with agent strip and input zone", () => {
    render(
      <ComposerStack
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
        todos={[{ id: "1", content: "Task A", status: "pending", priority: "high" } as never]}
      >
        <div data-testid="child-input">input</div>
      </ComposerStack>,
    );

    expect(screen.getByTestId("composer-stack")).toBeTruthy();
    expect(screen.getByTestId("streaming-agent-row")).toBeTruthy();
    expect(screen.getByTestId("composer-plan-slot")).toBeTruthy();
    expect(screen.getByTestId("composer-input-zone")).toBeTruthy();
    expect(screen.getByTestId("child-input")).toBeTruthy();
  });

  it("embeds approval inside the same shell and hides interrupt", () => {
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: { id: "perm-1", permission: "bash", patterns: ["ls -la"] },
          childSessionId: null,
          ownerSessionId: "sess-1",
        },
      ],
    });

    render(
      <ComposerStack
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    expect(screen.getByTestId("pending-permission-card")).toBeTruthy();
    expect(screen.queryByTestId("streaming-agent-stop")).toBeNull();
  });
});
