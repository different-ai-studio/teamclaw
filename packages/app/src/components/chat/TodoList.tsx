import React from 'react'
import { CheckCircle2, Circle, Clock, XCircle } from 'lucide-react'
import type { Todo } from '@/lib/opencode/sdk-types'

interface TodoListProps {
  todos: Todo[]
  compact?: boolean
}

export const TodoList = React.memo(function TodoList({ todos, compact: _compact }: TodoListProps) {
  if (todos.length === 0) return null

  const getStatusIcon = (status: Todo['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
      case 'in_progress':
        return <Clock className="h-3.5 w-3.5 text-blue-500 animate-pulse shrink-0" />
      case 'cancelled':
        return <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      default:
        return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    }
  }

  const completedCount = todos.filter(t => t.status === 'completed').length

  return (
    <div data-testid="todo-list" className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
      {/* Header */}
      <div className="flex items-center justify-between text-xs text-muted-foreground pb-1.5 mb-1.5 border-b border-border/50">
        <span>{completedCount}/{todos.length} done</span>
      </div>

      {/* Task list */}
      <div className="space-y-1">
      {todos.map(todo => (
        <div
          key={todo.id}
          className={`flex items-start gap-2 py-1 ${
            todo.status === 'completed' ? 'opacity-50' : ''
          }`}
        >
          {getStatusIcon(todo.status)}
          <span
            className={`text-xs leading-relaxed ${
              todo.status === 'completed' ? 'line-through text-muted-foreground' : ''
            }`}
          >
            {todo.content}
          </span>
        </div>
      ))}
      </div>
    </div>
  )
})
