import * as React from 'react'
import { HelpCircle, Check, ChevronRight, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSessionStore } from '@/stores/session'
import type { Question } from '@/lib/opencode/types'

interface QuestionCardProps {
  toolCallId: string
  questions: Question[]
  isCompleted?: boolean
}

export const QuestionCard = React.memo(function QuestionCard({ toolCallId, questions, isCompleted }: QuestionCardProps) {
  const pendingQuestion = useSessionStore(s => s.pendingQuestion)
  const answerQuestion = useSessionStore(s => s.answerQuestion)
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [customInputs, setCustomInputs] = React.useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [hasSubmitted, setHasSubmitted] = React.useState(false)

  const isPending = pendingQuestion?.toolCallId === toolCallId
  // Show as waiting for completion if submitted but not yet completed
  const isWaitingForCompletion = hasSubmitted && !isCompleted

  const handleOptionSelect = (questionIndex: number, option: string) => {
    const questionId = questions[questionIndex]?.id || String(questionIndex)
    setAnswers(prev => ({ ...prev, [questionId]: option }))
  }

  const handleCustomInput = (questionIndex: number, value: string) => {
    const questionId = questions[questionIndex]?.id || String(questionIndex)
    setCustomInputs(prev => ({ ...prev, [questionId]: value }))
  }

  const handleSubmit = async () => {
    // Merge selected options with custom inputs (custom input takes precedence if filled)
    const finalAnswers: Record<string, string> = {}
    questions.forEach((q, idx) => {
      const questionId = q.id || String(idx)
      const customInput = customInputs[questionId]?.trim()
      if (customInput) {
        finalAnswers[questionId] = customInput
      } else if (answers[questionId]) {
        finalAnswers[questionId] = answers[questionId]
      }
    })

    if (Object.keys(finalAnswers).length === 0) return

    setIsSubmitting(true)
    try {
      await answerQuestion(finalAnswers)
      setHasSubmitted(true)
    } finally {
      setIsSubmitting(false)
    }
  }

  const hasAllAnswers = questions.every((q, idx) => {
    const questionId = q.id || String(idx)
    return answers[questionId] || customInputs[questionId]?.trim()
  })
  
  // Determine if we should show the interactive UI (options to select)
  const showInteractiveUI = isPending && !hasSubmitted

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-muted/30 border-b">
        <HelpCircle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Question</span>
        {isCompleted && (
          <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
            <Check className="h-3 w-3 text-foreground/60" />
            Answered
          </span>
        )}
        {isWaitingForCompletion && (
          <span className="ml-auto text-xs text-muted-foreground animate-pulse">
            Processing answer...
          </span>
        )}
        {isPending && !hasSubmitted && (
          <span className="ml-auto text-xs text-muted-foreground animate-pulse">
            Waiting for response...
          </span>
        )}
      </div>

      {/* Questions */}
      <div className="p-4 space-y-6">
        {questions.map((question, qIndex) => {
          const questionId = question.id || String(qIndex)
          const selectedOption = answers[questionId]
          const customInput = customInputs[questionId] || ''

          return (
            <div key={questionId} className="space-y-3">
              {/* Question header and text */}
              {question.header && (
                <div className="text-sm font-medium text-foreground">
                  {question.header}
                </div>
              )}
              <div className="text-sm text-muted-foreground">
                {question.question}
              </div>

              {/* Options */}
              {showInteractiveUI && question.options && question.options.length > 0 &&
                question.options.map((option, optIndex) => {
                  const optionValue = option.value || option.label
                  const isSelected = selectedOption === optionValue

                  return (
                    <button
                      key={optIndex}
                      onClick={() => handleOptionSelect(qIndex, optionValue)}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all',
                        isSelected
                          ? 'border-foreground/30 bg-muted/70 text-foreground'
                          : 'border-border hover:border-foreground/20 hover:bg-muted/50'
                      )}
                      disabled={isCompleted || isSubmitting}
                    >
                      <div
                        className={cn(
                          'flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
                          isSelected
                            ? 'border-foreground/60 bg-foreground/10'
                            : 'border-muted-foreground/50'
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3 text-foreground" />}
                      </div>
                      <span className="text-sm flex-1">{option.label}</span>
                      <ChevronRight
                        className={cn(
                          'h-4 w-4 transition-opacity',
                          isSelected ? 'opacity-100 text-foreground/70' : 'opacity-0'
                        )}
                      />
                    </button>
                  )
                })
              }

              {/* Text input - always shown when interactive */}
              {showInteractiveUI && (
                <div className="pt-2">
                  <Input
                    placeholder={question.options?.length ? "Or type a custom answer..." : "Type your answer..."}
                    value={customInput}
                    onChange={(e) => handleCustomInput(qIndex, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && hasAllAnswers) {
                        e.preventDefault()
                        handleSubmit()
                      }
                    }}
                    disabled={isCompleted || isSubmitting}
                    className="text-sm"
                  />
                </div>
              )}

              {/* Show selected answer for completed or submitted questions */}
              {(isCompleted || isWaitingForCompletion) && (selectedOption || customInput) && (
                <div className="px-4 py-2 rounded-lg bg-muted/50 text-sm">
                  <span className="text-muted-foreground">Answer: </span>
                  <span className="font-medium">{customInput || selectedOption}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Submit button */}
      {showInteractiveUI && (
        <div className="px-4 pb-4">
          <Button
            onClick={handleSubmit}
            disabled={!hasAllAnswers || isSubmitting}
            className="w-full gap-2"
          >
            <Send className="h-4 w-4" />
            {isSubmitting ? 'Submitting...' : 'Submit Answer'}
          </Button>
        </div>
      )}
    </div>
  )
});
