import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TodoList } from "../TodoList";

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
});
