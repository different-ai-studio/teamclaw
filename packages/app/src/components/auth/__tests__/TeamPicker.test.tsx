import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TeamPicker } from "../TeamPicker";

// Selector-style mock of the current-team store: the component reads it via
// useCurrentTeamStore((s) => s.switchToTeam).
const switchToTeam = vi.fn(async () => {});
vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: (sel: (s: { switchToTeam: typeof switchToTeam }) => unknown) =>
    sel({ switchToTeam }),
}));

const teams = [
  { id: "t1", name: "Alpha", slug: "alpha", orgId: "o1", orgName: "Org One" },
  { id: "t2", name: "Beta", slug: "beta", orgId: "o2", orgName: "Org Two" },
];

describe("TeamPicker", () => {
  // Assert on data (org/team names), not translated chrome — the unit test env
  // runs in zh-CN per project convention.
  it("renders teams grouped by org", () => {
    render(<TeamPicker teams={teams} onDone={() => {}} />);
    expect(screen.getByText("Org One")).toBeInTheDocument();
    expect(screen.getByText("Org Two")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("calls switchToTeam and onDone on selection", async () => {
    const onDone = vi.fn();
    render(<TeamPicker teams={teams} onDone={onDone} />);
    fireEvent.click(screen.getByText("Beta"));
    await vi.waitFor(() => expect(switchToTeam).toHaveBeenCalledWith("t2"));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("badges the last-used team (zh-CN: 最后使用)", () => {
    render(<TeamPicker teams={teams} lastUsedTeamId="t2" onDone={() => {}} />);
    expect(screen.getByText("最后使用")).toBeInTheDocument();
  });

  it("shows no last-used badge on first login (no history)", () => {
    render(<TeamPicker teams={teams} onDone={() => {}} />);
    expect(screen.queryByText("最后使用")).not.toBeInTheDocument();
  });
});
