import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TeamPicker } from "../TeamPicker";

const { bootstrapTeam } = vi.hoisted(() => ({
  bootstrapTeam: vi.fn(async () => ({ id: "created-team", name: "Empty Org", slug: "empty-org" })),
}));
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ teams: { bootstrapTeam } }),
}));

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

  // Strict single-org: entering a team moves the account's active org, so the
  // other orgs' teams stop being readable. The picker lists them all anyway,
  // which makes the choice look free — say so when it isn't.
  it("warns that only one organization is usable at a time when orgs span more than one", () => {
    render(<TeamPicker teams={teams} onDone={() => {}} />);
    expect(screen.getByText(/同一时间只能在一个组织内工作/)).toBeInTheDocument();
  });

  it("omits the single-org warning when every team is in one org", () => {
    const sameOrg = [
      { id: "t1", name: "Alpha", slug: "alpha", orgId: "o1", orgName: "Org One" },
      { id: "t3", name: "Gamma", slug: "gamma", orgId: "o1", orgName: "Org One" },
    ];
    render(<TeamPicker teams={sameOrg} onDone={() => {}} />);
    expect(screen.queryByText(/同一时间只能在一个组织内工作/)).not.toBeInTheDocument();
  });

  it("initializes an empty org before activating its newly created team", async () => {
    render(<TeamPicker teams={[{ id: "o-empty", name: "Empty Org", orgId: "o-empty", orgName: "Empty Org", itemType: "org", teamId: null }]} onDone={() => {}} />);
    fireEvent.click(screen.getByText("初始化 Empty Org"));
    await vi.waitFor(() => expect(bootstrapTeam).toHaveBeenCalledWith({ orgId: "o-empty" }));
    await vi.waitFor(() => expect(switchToTeam).toHaveBeenCalledWith("created-team"));
  });

  /*
   * Teams are named after their org and the name is not unique, so an org where
   * several people onboarded shows several identical rows. These cover the
   * annotation that tells them apart — and, just as importantly, that it stays
   * out of the way when the name is already unambiguous.
   *
   * The date part is deliberately not asserted: formatDate is locale-driven, and
   * pinning its exact output would make this a test of Intl.
   */
  const sameName = [
    { id: "t1", name: "香蕉攀岩", slug: "team", orgId: "o1", orgName: "香蕉攀岩",
      ownerName: "周金亮", memberCount: 68, createdAt: "2026-06-16T12:53:21Z" },
    { id: "t4", name: "香蕉攀岩", slug: "team-4", orgId: "o1", orgName: "香蕉攀岩",
      ownerName: "蜕变", memberCount: 24, createdAt: "2026-08-07T07:59:58Z" },
  ];

  it("annotates same-named teams with owner and size", () => {
    render(<TeamPicker teams={sameName} onDone={() => {}} />);
    expect(screen.getByText(/周金亮 · 68 人/)).toBeInTheDocument();
    expect(screen.getByText(/蜕变 · 24 人/)).toBeInTheDocument();
  });

  it("leaves uniquely named teams unannotated", () => {
    const distinct = [
      { id: "t1", name: "Alpha", slug: "alpha", orgId: "o1", orgName: "Org One",
        ownerName: "周金亮", memberCount: 68, createdAt: "2026-06-16T12:53:21Z" },
      { id: "t3", name: "Gamma", slug: "gamma", orgId: "o1", orgName: "Org One",
        ownerName: "蜕变", memberCount: 24, createdAt: "2026-08-07T07:59:58Z" },
    ];
    render(<TeamPicker teams={distinct} onDone={() => {}} />);
    expect(screen.queryByText(/周金亮/)).not.toBeInTheDocument();
    expect(screen.queryByText(/蜕变/)).not.toBeInTheDocument();
  });

  // The org heading already separates these, so annotating them would be noise.
  it("leaves same-named teams in different orgs unannotated", () => {
    const crossOrg = [
      { ...sameName[0], orgId: "o1", orgName: "Org One" },
      { ...sameName[1], orgId: "o2", orgName: "Org Two" },
    ];
    render(<TeamPicker teams={crossOrg} onDone={() => {}} />);
    expect(screen.queryByText(/周金亮/)).not.toBeInTheDocument();
  });

  // The Postgres backend supplies no owner, and an older server supplies none of
  // the three. Either way the row must not render "undefined".
  it("drops the parts the backend did not supply", () => {
    const partial = [
      { id: "t1", name: "香蕉攀岩", slug: "team", orgId: "o1", orgName: "香蕉攀岩", memberCount: 68 },
      { id: "t4", name: "香蕉攀岩", slug: "team-4", orgId: "o1", orgName: "香蕉攀岩" },
    ];
    render(<TeamPicker teams={partial} onDone={() => {}} />);
    expect(screen.getByText("68 人")).toBeInTheDocument();
    expect(screen.queryByText(/undefined|NaN/)).not.toBeInTheDocument();
  });

});
