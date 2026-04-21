import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const mockSessionState = {
  pendingQuestions: [] as Array<{
    questionId: string;
    toolCallId: string;
    messageId: string;
    questions: unknown[];
  }>,
  answerQuestion: vi.fn(() => Promise.resolve()),
};

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: typeof mockSessionState) => unknown) =>
    selector(mockSessionState),
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    question: 'What would you like to do?',
    header: 'Choose an option',
    options: [
      { label: 'Option A', value: 'option-a' },
      { label: 'Option B', value: 'option-b' },
    ],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('QuestionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.pendingQuestions = [];
    mockSessionState.answerQuestion = vi.fn(() => Promise.resolve());
  });

  it('renders question text and options', async () => {
    const question = makeQuestion();
    mockSessionState.pendingQuestions = [
      {
        questionId: 'event-1',
        toolCallId: 'tc-1',
        messageId: 'msg-1',
        questions: [question],
      },
    ];

    const { QuestionCard } = await import('../QuestionCard');

    render(
      <QuestionCard
        toolCallId="tc-1"
        questions={[question as never]}
        isCompleted={false}
      />
    );

    expect(screen.getByTestId('question-card').className).toContain('rounded-xl');
    expect(screen.getByText('What would you like to do?')).toBeTruthy();
    expect(screen.getByText('Option A')).toBeTruthy();
    expect(screen.getByText('Option B')).toBeTruthy();
  });

  it('clicking an option and submitting calls answerQuestion with correct mapping', async () => {
    const question = makeQuestion();
    const answerMock = vi.fn(() => Promise.resolve());
    mockSessionState.pendingQuestions = [
      {
        questionId: 'event-1',
        toolCallId: 'tc-1',
        messageId: 'msg-1',
        questions: [question],
      },
    ];
    mockSessionState.answerQuestion = answerMock;

    const { QuestionCard } = await import('../QuestionCard');

    render(
      <QuestionCard
        toolCallId="tc-1"
        questions={[question as never]}
        isCompleted={false}
      />
    );

    // Click Option A
    const optionAButton = screen.getByText('Option A').closest('button');
    expect(optionAButton).not.toBeNull();
    fireEvent.click(optionAButton!);

    // Click the Submit Answer button
    const submitButton = screen.getByText('Submit Answer');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(answerMock).toHaveBeenCalledWith({ 'q-1': 'option-a' }, 'event-1');
    });
  });
});
