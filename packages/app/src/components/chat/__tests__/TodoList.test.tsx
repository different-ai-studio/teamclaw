import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TodoList } from "../TodoList";

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

describe("TodoList", () => {
  it("renders as a lightweight card with task summary", () => {
    render(
      <TodoList
        todos={[
          { id: "1", content: "Inspect parser config", status: "completed", priority: "high" } as never,
          { id: "2", content: "Update role load UI", status: "in_progress", priority: "medium" } as never,
        ]}
      />,
    );

    const card = screen.getByTestId("todo-list");
    expect(card.className).toContain("rounded-xl");
    expect(card.className).toContain("bg-card/70");
    expect(screen.getByText("1/2 done")).toBeTruthy();
  });

  it("renders an inline docked panel with localized summary", () => {
    render(
      <TodoList
        variant="inline"
        todos={[
          { id: "1", content: "Inspect parser config", status: "completed", priority: "high" } as never,
          { id: "2", content: "Update role load UI", status: "in_progress", priority: "medium" } as never,
          { id: "3", content: "Verify markdown rendering", status: "pending", priority: "low" } as never,
        ]}
      />,
    );

    expect(screen.getByTestId("todo-list-inline")).toBeTruthy();
    expect(screen.getByText("3 tasks, 1 completed")).toBeTruthy();
    expect(screen.getByText("Update role load UI")).toBeTruthy();
    expect(screen.getByTestId("todo-list-inline-scroll").className).toContain("max-h-[8.75rem]");
    expect(screen.getByTestId("todo-list-inline-scroll").className).toContain("overflow-y-auto");
    expect((screen.getByTestId("todo-list-inline-scroll").firstChild as HTMLElement).className).toContain("items-center");
  });

  it("collapses the inline panel into a summary strip", () => {
    render(
      <TodoList
        variant="inline"
        todos={[
          { id: "1", content: "Inspect parser config", status: "completed", priority: "high" } as never,
          { id: "2", content: "Update role load UI", status: "in_progress", priority: "medium" } as never,
          { id: "3", content: "Verify markdown rendering", status: "pending", priority: "low" } as never,
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse todo panel" }));

    expect(screen.queryByText("Inspect parser config")).toBeNull();
    expect(screen.getByText("In progress: Update role load UI")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand todo panel" })).toBeTruthy();
  });

  it("starts collapsed when all todos are completed", () => {
    render(
      <TodoList
        variant="inline"
        todos={[
          { id: "1", content: "Inspect parser config", status: "completed", priority: "high" } as never,
          { id: "2", content: "Update role load UI", status: "completed", priority: "medium" } as never,
        ]}
      />,
    );

    expect(screen.getByText("All tasks completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand todo panel" })).toBeTruthy();
    expect(screen.queryByText("Inspect parser config")).toBeNull();
  });

  it("auto-expands when todos update while collapsed", () => {
    const initialTodos = [
      { id: "1", content: "Inspect parser config", status: "completed", priority: "high" } as never,
      { id: "2", content: "Update role load UI", status: "in_progress", priority: "medium" } as never,
    ];
    const { rerender } = render(<TodoList variant="inline" todos={initialTodos} />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse todo panel" }));
    expect(screen.getByRole("button", { name: "Expand todo panel" })).toBeTruthy();

    rerender(
      <TodoList
        variant="inline"
        todos={[
          { id: "1", content: "Inspect parser config", status: "completed", priority: "high" } as never,
          { id: "2", content: "Update role load UI", status: "completed", priority: "medium" } as never,
          { id: "3", content: "Verify markdown rendering", status: "in_progress", priority: "low" } as never,
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Collapse todo panel" })).toBeTruthy();
    expect(screen.getByText("Verify markdown rendering")).toBeTruthy();
  });
});
