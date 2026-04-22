import React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Clock3, ListTodo, XCircle } from "lucide-react";
import type { Todo } from "@/lib/opencode/sdk-types";
import { cn } from "@/lib/utils";

interface TodoListProps {
  todos: Todo[];
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

function getActiveTodo(todos: Todo[]) {
  return (
    todos.find((todo) => todo.status === "in_progress") ||
    todos.find((todo) => todo.status === "pending") ||
    todos[0] ||
    null
  );
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

function InlineTodoList({ todos }: { todos: Todo[] }) {
  const { t } = useTranslation();
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const allCompleted = completedCount === todos.length;
  const [collapsed, setCollapsed] = React.useState(allCompleted);
  const activeTodo = getActiveTodo(todos);
  const todoSignature = React.useMemo(
    () => todos.map((todo) => `${todo.id}:${todo.status}:${todo.content}`).join("|"),
    [todos],
  );
  const previousSignatureRef = React.useRef(todoSignature);

  React.useEffect(() => {
    if (allCompleted) {
      setCollapsed(true);
    }
  }, [allCompleted]);

  React.useEffect(() => {
    if (previousSignatureRef.current !== todoSignature) {
      previousSignatureRef.current = todoSignature;
      if (!allCompleted) {
        setCollapsed(false);
      }
    }
  }, [allCompleted, todoSignature]);

  return (
    <div
      data-testid="todo-list-inline"
      className={cn(
        "relative z-0 mx-auto w-[calc(100%-3.5rem)] max-w-[42rem] px-2",
        collapsed ? "-mb-6" : "-mb-10",
      )}
    >
      <div
        className={cn(
          "overflow-hidden rounded-[24px] border border-[rgba(214,219,228,0.92)] bg-[rgba(250,251,252,0.10)] shadow-[0_1px_3px_rgba(15,23,42,0.03)] backdrop-blur-md supports-[backdrop-filter]:bg-[rgba(250,251,252,0.05)] transition-all dark:border-white/12 dark:bg-[rgba(15,23,42,0.28)] dark:supports-[backdrop-filter]:bg-[rgba(15,23,42,0.22)]",
          collapsed ? "pb-1" : "pb-10",
        )}
      >
        <div className={cn("flex items-center gap-2.5 px-4", collapsed ? "py-2" : "py-3")}>
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-[12px] font-medium text-muted-foreground">
            {t("chat.todo.summary", "{{count}} tasks, {{completed}} completed", {
              count: todos.length,
              completed: completedCount,
            })}
          </div>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={
              collapsed
                ? t("chat.todo.expandAria", "Expand todo panel")
                : t("chat.todo.collapseAria", "Collapse todo panel")
            }
            onClick={() => setCollapsed((value) => !value)}
            className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        </div>

        {collapsed ? (
          <div className="px-4 pb-0 text-[12px] leading-4 text-foreground/90">
            {!allCompleted && activeTodo
              ? t("chat.todo.activeSummary", "In progress: {{task}}", { task: activeTodo.content })
              : t("chat.todo.allCompleted", "All tasks completed")}
          </div>
        ) : (
          <div
            data-testid="todo-list-inline-scroll"
            className="space-y-2 overflow-y-auto px-4 pb-1 max-h-[8.75rem]"
          >
            {todos.map((todo, index) => (
              <div
                key={todo.id}
                className={cn(
                  "grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5",
                  todo.status === "completed" && "opacity-65",
                )}
              >
                <div>{getTodoStatusIcon(todo.status, "h-3.5 w-3.5")}</div>
                <div
                  className={cn(
                    "text-[14px] leading-6 text-foreground",
                    todo.status === "completed" && "text-muted-foreground line-through",
                  )}
                >
                  <span className="mr-1.5 text-muted-foreground">{index + 1}.</span>
                  {todo.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const TodoList = React.memo(function TodoList({
  todos,
  compact: _compact,
  variant = "sidebar",
}: TodoListProps) {
  if (todos.length === 0) return null;

  if (variant === "inline") {
    return <InlineTodoList todos={todos} />;
  }

  return <SidebarTodoList todos={todos} />;
});
