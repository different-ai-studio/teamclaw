import React from "react";
import { CheckCircle2, Circle, Clock3, XCircle } from "lucide-react";
import type { Todo } from "@/stores/session-types";
import type { QueuedMessage } from "@/stores/session";
import { cn } from "@/lib/utils";
import { ComposerPlanSlot } from "./ComposerPlanSlot";

interface TodoListProps {
  todos?: Todo[];
  queue?: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  compact?: boolean;
  variant?: "sidebar" | "inline";
}

function getTodoStatusIcon(status: Todo["status"], className?: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className={cn("shrink-0 text-green-500", className)} />;
    case "in_progress":
      return <Clock3 className={cn("shrink-0 text-blue-500", className)} />;
    case "cancelled":
      return <XCircle className={cn("shrink-0 text-muted-foreground", className)} />;
    default:
      return <Circle className={cn("shrink-0 text-muted-foreground", className)} />;
  }
}

function SidebarTodoList({ todos }: { todos: Todo[] }) {
  const completedCount = todos.filter((todo) => todo.status === "completed").length;

  return (
    <div data-testid="todo-list" className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between border-b border-border/50 pb-1.5 text-xs text-muted-foreground">
        <span>{completedCount}/{todos.length} done</span>
      </div>

      <div className="space-y-1">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={cn("flex items-start gap-2 py-1", todo.status === "completed" && "opacity-50")}
          >
            {getTodoStatusIcon(todo.status, "h-3.5 w-3.5")}
            <span
              className={cn(
                "text-xs leading-relaxed",
                todo.status === "completed" && "line-through text-muted-foreground",
              )}
            >
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const TodoList = React.memo(function TodoList({
  todos = [],
  queue = [],
  onRemoveFromQueue,
  compact: _compact,
  variant = "sidebar",
}: TodoListProps) {
  if (todos.length === 0 && queue.length === 0) return null;

  if (variant === "inline") {
    return (
      <ComposerPlanSlot
        todos={todos}
        queue={queue}
        onRemoveFromQueue={onRemoveFromQueue}
      />
    );
  }

  return <SidebarTodoList todos={todos} />;
});
