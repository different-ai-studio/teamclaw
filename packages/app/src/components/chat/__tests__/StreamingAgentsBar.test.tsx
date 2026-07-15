import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { StreamingAgentsBar } from "../StreamingAgentsBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/hooks/useActorDisplayName", () => ({
  useActorDisplayName: (actorId: string) => `Agent ${actorId.slice(-1)}`,
}));

describe("StreamingAgentsBar", () => {
  it("renders nothing when no agents are streaming", () => {
    const { container } = render(
      <StreamingAgentsBar agents={[]} onInterrupt={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders one row per active agent with interrupt control", () => {
    const onInterrupt = vi.fn();
    const { getByTestId, getAllByTestId } = render(
      <StreamingAgentsBar
        agents={[
          { actorId: "agent-a", displayName: "Alpha" },
          { actorId: "agent-b", displayName: "Beta" },
        ]}
        onInterrupt={onInterrupt}
      />,
    );

    expect(getByTestId("streaming-agents-dock")).toBeTruthy();
    expect(getAllByTestId("streaming-agent-row")).toHaveLength(2);

    fireEvent.click(getAllByTestId("streaming-agent-stop")[0]);
    expect(onInterrupt).toHaveBeenCalledWith("agent-a");
  });
});
