import React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Clock3, ListTodo, Trash2, XCircle } from "lucide-react";
import type { Todo } from "@/lib/opencode/sdk-types";
import type { QueuedMessage } from "@/stores/session";
import { cn } from "@/lib/utils";

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

function SectionHeader({
  icon,
  label,
  isTop,
  collapsed,
  collapseAria,
  expandAria,
  onToggleCollapsed,
}: {
  icon: React.ReactNode;
  label: string;
  isTop: boolean;
  collapsed: boolean;
  collapseAria: string;
  expandAria: string;
  onToggleCollapsed: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 px-4 text-[12px] font-medium text-muted-foreground",
        isTop ? "rounded-t-[24px] bg-white/25 py-3 dark:bg-white/5" : "bg-white/10 py-2.5 dark:bg-white/[0.03]",
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">{label}</div>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? expandAria : collapseAria}
        onClick={onToggleCollapsed}
        className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
      >
        {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
      </button>
    </div>
  );
}

function InlineTodoList({
  todos,
  queue,
  onRemoveFromQueue,
}: {
  todos: Todo[];
  queue: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const allCompleted = todos.length > 0 && completedCount === todos.length;
  const [todoCollapsed, setTodoCollapsed] = React.useState(allCompleted);
  const [queueCollapsed, setQueueCollapsed] = React.useState(false);
  const activeTodo = getActiveTodo(todos);
  const hasTodos = todos.length > 0;
  const hasQueue = queue.length > 0;
  const hasAnyContent = hasTodos || hasQueue;
  const todoSignature = React.useMemo(
    () => todos.map((todo) => `todo:${todo.id}:${todo.status}:${todo.content}`).join("|"),
    [todos],
  );
  const queueSignature = React.useMemo(
    () => queue.map((msg) => `queue:${msg.id}:${msg.content}`).join("|"),
    [queue],
  );
  const previousTodoSignatureRef = React.useRef(todoSignature);
  const previousQueueSignatureRef = React.useRef(queueSignature);

  React.useEffect(() => {
    if (hasTodos && allCompleted) {
      setTodoCollapsed(true);
    }
  }, [allCompleted, hasTodos]);

  React.useEffect(() => {
    if (previousTodoSignatureRef.current !== todoSignature) {
      previousTodoSignatureRef.current = todoSignature;
      if (!allCompleted) {
        setTodoCollapsed(false);
      }
    }
  }, [allCompleted, todoSignature]);

  React.useEffect(() => {
    if (previousQueueSignatureRef.current !== queueSignature) {
      previousQueueSignatureRef.current = queueSignature;
      if (queue.length > 0) {
        setQueueCollapsed(false);
      }
    }
  }, [queue.length, queueSignature]);

  if (!hasAnyContent) return null;

  const topSection = hasTodos ? "todo" : "queue";
  const dockCollapsed = (!hasTodos || todoCollapsed) && (!hasQueue || queueCollapsed);
  const showCollapsedTodoSummary = todoCollapsed && !allCompleted && (!hasQueue || !queueCollapsed);
  const headerOnlyCollapsed = dockCollapsed && !showCollapsedTodoSummary && (!hasQueue || queueCollapsed);

  return (
    <div
      data-testid="todo-list-inline"
      className={cn(
        "relative z-0 mx-auto w-[calc(100%-3.5rem)] max-w-[42rem] px-2",
        dockCollapsed ? (headerOnlyCollapsed ? "-mb-1" : "-mb-6") : "-mb-10",
      )}
    >
      <div
        className={cn(
          "overflow-hidden rounded-[24px] border border-[rgba(214,219,228,0.92)] bg-[rgba(250,251,252,0.07)] shadow-[0_1px_3px_rgba(15,23,42,0.03)] backdrop-blur-md supports-[backdrop-filter]:bg-[rgba(250,251,252,0.035)] dark:border-white/12 dark:bg-[rgba(15,23,42,0.22)] dark:supports-[backdrop-filter]:bg-[rgba(15,23,42,0.16)]",
          dockCollapsed ? "pb-1" : "pb-10",
          headerOnlyCollapsed && "rounded-b-none pb-0",
        )}
      >
        <>
          {hasTodos ? (
            <section className={cn(hasQueue && "border-b border-white/40 dark:border-white/10")}>
              <SectionHeader
                icon={<ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                label={t("chat.todo.summary", "{{count}} tasks, {{completed}} completed", {
                  count: todos.length,
                  completed: completedCount,
                })}
                isTop={topSection === "todo"}
                collapsed={todoCollapsed}
                collapseAria={t("chat.todo.collapseAria", "Collapse todo panel")}
                expandAria={t("chat.todo.expandAria", "Expand todo panel")}
                onToggleCollapsed={() => setTodoCollapsed((value) => !value)}
              />
              <div
                data-testid="todo-list-inline-scroll-shell"
                aria-hidden={todoCollapsed}
                className={cn(
                  "overflow-hidden transition-[max-height,opacity,padding] duration-200 ease-in-out",
                  !todoCollapsed ? "max-h-[11rem] opacity-100 px-4 py-3" : "max-h-0 opacity-0 px-4 py-0",
                )}
              >
                <div
                  data-testid="todo-list-inline-scroll"
                  className="space-y-2 overflow-y-auto max-h-[8.75rem]"
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
              </div>
              {showCollapsedTodoSummary ? (
                <div className="px-4 pb-0 text-[12px] leading-4 text-foreground/90">
                  {activeTodo
                    ? t("chat.todo.activeSummary", "In progress: {{task}}", { task: activeTodo.content })
                    : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {hasQueue ? (
            <section data-testid="todo-list-inline-queue">
              <SectionHeader
                icon={<Clock3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                label={t("chat.messagesQueued", "{{count}} messages queued", { count: queue.length })}
                isTop={topSection === "queue"}
                collapsed={queueCollapsed}
                collapseAria={t("chat.todo.queueCollapseAria", "Collapse queued messages")}
                expandAria={t("chat.todo.queueExpandAria", "Expand queued messages")}
                onToggleCollapsed={() => setQueueCollapsed((value) => !value)}
              />
              <div
                data-testid="todo-list-inline-queue-shell"
                aria-hidden={queueCollapsed}
                className={cn(
                  "overflow-hidden transition-[max-height,opacity,padding] duration-200 ease-in-out",
                  !queueCollapsed ? "max-h-[10rem] opacity-100 px-4 py-3" : "max-h-0 opacity-0 px-4 py-0",
                )}
              >
                <div
                  className="space-y-1.5 overflow-y-auto max-h-[8.5rem]"
                  data-testid="todo-list-inline-queue-body"
                >
                  {queue.map((msg, index) => (
                    <div
                      key={msg.id}
                      className="group flex items-center gap-3 text-[13px] leading-5 text-foreground"
                    >
                      <span className="w-5 shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
                      <span className="min-w-0 flex-1 truncate">{msg.content}</span>
                      {onRemoveFromQueue ? (
                        <button
                          type="button"
                          onClick={() => onRemoveFromQueue(msg.id)}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                          title={t("common.remove", "Remove")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}
        </>
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
    return <InlineTodoList todos={todos} queue={queue} onRemoveFromQueue={onRemoveFromQueue} />;
  }

  return <SidebarTodoList todos={todos} />;
});
