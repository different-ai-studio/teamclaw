import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, CornerDownLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session";
import type { PendingQuestionState } from "@/stores/session-types";

interface QuestionInputDockProps {
  pendingQuestion: PendingQuestionState;
  compact?: boolean;
  onHeightChange?: (height: number) => void;
}

function getOptionValue(option: { label: string; value?: string }) {
  return option.value ?? option.label;
}

function getQuestionId(question: { id?: string }, index: number) {
  return question.id || String(index);
}

export function QuestionInputDock({
  pendingQuestion,
  compact = false,
  onHeightChange,
}: QuestionInputDockProps) {
  const { t } = useTranslation();
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const skipQuestion = useSessionStore((s) => s.skipQuestion);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const lastReportedHeight = React.useRef(0);
  const questions = pendingQuestion.questions;
  const [questionIndex, setQuestionIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [customInputs, setCustomInputs] = React.useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [hasSubmitted, setHasSubmitted] = React.useState(false);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;

    const reportHeight = () => {
      const rounded = Math.round(el.getBoundingClientRect().height);
      if (rounded !== lastReportedHeight.current) {
        lastReportedHeight.current = rounded;
        onHeightChange(rounded);
      }
    };

    reportHeight();
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(reportHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeightChange]);

  React.useEffect(() => {
    setQuestionIndex((value) => Math.min(value, Math.max(questions.length - 1, 0)));
  }, [questions.length]);

  const currentQuestion = questions[questionIndex];
  const currentQuestionId = currentQuestion?.id || String(questionIndex);
  const hasSelectedAnswer = Object.prototype.hasOwnProperty.call(answers, currentQuestionId);
  const selectedAnswer = hasSelectedAnswer ? answers[currentQuestionId] : "";
  const customAnswer = customInputs[currentQuestionId] || "";
  const trimmedCustomAnswer = customAnswer.trim();
  const isLastQuestion = questionIndex >= questions.length - 1;
  const canContinue =
    (!!trimmedCustomAnswer || hasSelectedAnswer) &&
    !!pendingQuestion.questionId &&
    !isSubmitting &&
    !hasSubmitted;
  const canSkip = !!pendingQuestion.questionId && !isSubmitting && !hasSubmitted;
  const questionTitle = currentQuestion?.header || t("chat.toolCall.question.title", "Question");

  const hasAnswerForQuestion = React.useCallback((question: { id?: string }, index: number) => {
    const questionId = getQuestionId(question, index);
    return !!customInputs[questionId]?.trim() || Object.prototype.hasOwnProperty.call(answers, questionId);
  }, [answers, customInputs]);

  const buildFinalAnswers = React.useCallback(() => {
    const finalAnswers: Record<string, string> = {};
    questions.forEach((question, index) => {
      const questionId = getQuestionId(question, index);
      const custom = customInputs[questionId]?.trim();
      finalAnswers[questionId] = custom || (answers[questionId] ?? "");
    });
    return finalAnswers;
  }, [answers, customInputs, questions]);

  const shouldSubmitEmptyAnswerOnSkip = React.useMemo(
    () =>
      isLastQuestion &&
      questions.length > 1 &&
      questions.slice(0, -1).every(hasAnswerForQuestion) &&
      !!currentQuestion?.options?.some((option) => getOptionValue(option) === ""),
    [currentQuestion?.options, hasAnswerForQuestion, isLastQuestion, questions],
  );

  const handleOptionSelect = (value: string) => {
    setAnswers((prev) => ({ ...prev, [currentQuestionId]: value }));
    setCustomInputs((prev) => ({ ...prev, [currentQuestionId]: "" }));
    if (!isLastQuestion) {
      setQuestionIndex((index) => Math.min(index + 1, questions.length - 1));
    }
  };

  const handleCustomInput = (value: string) => {
    setCustomInputs((prev) => ({ ...prev, [currentQuestionId]: value }));
  };

  const handleContinue = async () => {
    if (!canContinue) return;
    if (!isLastQuestion) {
      setQuestionIndex((value) => Math.min(value + 1, questions.length - 1));
      return;
    }

    setIsSubmitting(true);
    try {
      await answerQuestion(buildFinalAnswers(), pendingQuestion.questionId);
      setHasSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = React.useCallback(async () => {
    if (!canSkip) return;
    setIsSubmitting(true);
    try {
      if (shouldSubmitEmptyAnswerOnSkip) {
        const finalAnswers = buildFinalAnswers();
        finalAnswers[currentQuestionId] = "";
        await answerQuestion(finalAnswers, pendingQuestion.questionId);
      } else {
        await skipQuestion(pendingQuestion.questionId);
      }
      setHasSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    answerQuestion,
    buildFinalAnswers,
    canSkip,
    currentQuestionId,
    pendingQuestion.questionId,
    shouldSubmitEmptyAnswerOnSkip,
    skipQuestion,
  ]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void handleSkip();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSkip]);

  if (!currentQuestion) return null;

  return (
    <div
      ref={rootRef}
      data-testid="question-input-dock"
      className={cn(
        "z-10",
        compact
          ? "absolute bottom-0 left-0 right-0 px-2 pb-2 pt-2 bg-background"
          : "absolute bottom-0 left-0 right-0 px-4 pb-4 pt-5",
      )}
    >
      <div className={cn("relative w-full", compact ? "" : "mx-auto max-w-[46rem]")}>
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-[-1px] right-[-1px] top-0 bottom-[-1.75rem] bg-background",
            compact && "hidden",
          )}
        />
        <section className="relative z-10 overflow-hidden rounded-[20px] border border-border/70 bg-card shadow-[0_18px_44px_rgba(15,23,42,0.12)]">
          <div className="flex items-center justify-between gap-4 px-4 pb-1 pt-3">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold leading-5 text-foreground">
                {questionTitle}
              </div>
            </div>
            {questions.length > 1 ? (
              <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                <button
                  type="button"
                  aria-label={t("common.previous", "Previous")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:text-foreground disabled:opacity-35"
                  disabled={questionIndex === 0}
                  onClick={() => setQuestionIndex((value) => Math.max(value - 1, 0))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="min-w-10 text-center text-xs font-semibold">{questionIndex + 1} of {questions.length}</span>
                <button
                  type="button"
                  aria-label={t("common.next", "Next")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:text-foreground disabled:opacity-35"
                  disabled={questionIndex === questions.length - 1}
                  onClick={() => setQuestionIndex((value) => Math.min(value + 1, questions.length - 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>

          <div className="px-4 pb-3 pt-3">
            <div className="mb-2.5 text-[13px] font-medium leading-5 text-muted-foreground">
              {currentQuestion.question}
            </div>

            <div className="space-y-1">
              {currentQuestion.options?.map((option, optionIndex) => {
                const optionValue = getOptionValue(option);
                const isSelected = hasSelectedAnswer && selectedAnswer === optionValue && !customAnswer.trim();
                return (
                  <button
                    key={`${optionValue}-${optionIndex}`}
                    type="button"
                    onClick={() => handleOptionSelect(optionValue)}
                    disabled={isSubmitting || hasSubmitted}
                    className={cn(
                      "grid min-h-9 w-full grid-cols-[2rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-[12px] px-2.5 text-left transition-colors",
                      isSelected
                        ? "bg-muted text-foreground"
                        : "text-foreground hover:bg-muted/45",
                    )}
                  >
                    <span className="text-[13px] font-semibold text-muted-foreground/85">{optionIndex + 1}.</span>
                    <span className="min-w-0 truncate text-sm font-semibold">
                      {option.label}
                      {optionIndex === 0 ? (
                        <span className="ml-2 rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {t("common.recommended", "Recommended")}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex justify-end">
                      {isSelected ? <Check className="h-4 w-4 text-foreground/65" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-1 grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 rounded-[12px] px-2.5 hover:bg-muted/30">
                <span className="text-[13px] font-semibold text-muted-foreground/85">
                  {(currentQuestion.options?.length || 0) + 1}.
                </span>
                <Input
                  value={customAnswer}
                  onChange={(event) => handleCustomInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleContinue();
                    }
                  }}
                  disabled={isSubmitting || hasSubmitted}
                  placeholder={
                    currentQuestion.options?.length
                      ? t("chat.toolCall.question.customAnswerPlaceholder", "Or type a custom answer...")
                      : t("chat.toolCall.question.answerPlaceholder", "Type your answer...")
                  }
                  className="h-9 min-w-0 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                />
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSkip()}
                  disabled={!canSkip}
                  className="whitespace-nowrap text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {t("common.skip", "Skip")} <kbd className="ml-1 rounded-md bg-muted px-1.5 py-[1px] text-[10px] font-semibold text-foreground/70">ESC</kbd>
                </button>
                <Button
                  type="button"
                  onClick={() => void handleContinue()}
                  disabled={!canContinue}
                  className="h-7 shrink-0 whitespace-nowrap rounded-full bg-[#111111] px-3 text-xs font-semibold text-white shadow-sm hover:bg-[#262626] disabled:bg-[#111111]/45 disabled:text-white/75 dark:bg-[#f4f4f5] dark:text-[#18181b] dark:hover:bg-white dark:disabled:bg-[#f4f4f5]/45 dark:disabled:text-[#18181b]/70"
                >
                  <CornerDownLeft className="h-2.5 w-2.5" />
                  {isSubmitting
                    ? t("chat.toolCall.question.submitting", "Submitting...")
                    : isLastQuestion
                      ? t("chat.toolCall.question.submitAnswer", "Submit Answer")
                      : t("common.continue", "Continue")}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
