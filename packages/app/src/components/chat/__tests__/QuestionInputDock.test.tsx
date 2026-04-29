import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuestionInputDock } from '../QuestionInputDock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));

const mockAnswerQuestion = vi.fn(() => Promise.resolve());
const mockSkipQuestion = vi.fn(() => Promise.resolve());

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (state: { answerQuestion: typeof mockAnswerQuestion; skipQuestion: typeof mockSkipQuestion }) => unknown) =>
    selector({
      answerQuestion: mockAnswerQuestion,
      skipQuestion: mockSkipQuestion,
    }),
}));

describe('QuestionInputDock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits an empty answer when skipping the final optional note question', async () => {
    render(
      <QuestionInputDock
        pendingQuestion={{
          questionId: 'question-event-1',
          toolCallId: 'tool-call-1',
          messageId: 'message-1',
          questions: [
            {
              id: 'q-1',
              header: '处理状态',
              question: '最终处理状态是什么？',
              options: [{ label: 'Resolved', value: 'resolved' }],
            },
            {
              id: 'q-2',
              header: 'Add note',
              question: 'Add one short optional note about the final root cause, handling, or remaining risk?',
              options: [{ label: 'No additional note', value: '' }],
            },
          ],
          source: 'opencode',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /resolved/i }));
    expect(screen.getByText(/add one short optional note/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => {
      expect(mockAnswerQuestion).toHaveBeenCalledWith(
        { 'q-1': 'resolved', 'q-2': '' },
        'question-event-1',
      );
    });
    expect(mockSkipQuestion).not.toHaveBeenCalled();
  });

  it('still rejects a normal single-question flow when skipped', async () => {
    render(
      <QuestionInputDock
        pendingQuestion={{
          questionId: 'question-event-2',
          toolCallId: 'tool-call-2',
          messageId: 'message-2',
          questions: [
            {
              id: 'q-1',
              header: '下一步',
              question: '你希望我接下来做什么？',
              options: [{ label: '继续测试', value: 'continue' }],
            },
          ],
          source: 'opencode',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => {
      expect(mockSkipQuestion).toHaveBeenCalledWith('question-event-2');
    });
    expect(mockAnswerQuestion).not.toHaveBeenCalled();
  });
});
