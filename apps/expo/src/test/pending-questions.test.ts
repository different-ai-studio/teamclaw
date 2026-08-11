import { describe, expect, it } from "vitest";

import {
  areAnswersComplete,
  buildQuestionAnswers,
  decodePendingQuestion,
  decodeQuestionRequestId,
  removePendingQuestion,
  upsertPendingQuestion,
  type PendingAcpQuestion,
} from "../features/sessions/pending-questions";

describe("decodePendingQuestion", () => {
  it("decodes questions with string and object options", () => {
    const question = decodePendingQuestion(
      {
        id: "req-1",
        questions: [
          {
            header: "Pick a branch",
            question: "Which branch should I target?",
            options: ["main", { label: "develop", description: "integration branch" }, ""],
            multiple: true,
          },
        ],
      },
      "agent-1",
    );

    expect(question).toEqual({
      id: "req-1",
      agentActorId: "agent-1",
      questions: [
        {
          id: "0",
          header: "Pick a branch",
          question: "Which branch should I target?",
          options: [
            { label: "main", description: "" },
            { label: "develop", description: "integration branch" },
          ],
          allowsMultiple: true,
        },
      ],
    });
  });

  it("defaults the header and drops entries with no question text", () => {
    const question = decodePendingQuestion(
      {
        id: "req-1",
        questions: [{ question: "" }, { question: "Proceed?" }],
      },
      "agent-1",
    );
    expect(question?.questions).toHaveLength(1);
    // The surviving entry keeps its ORIGINAL index, so answers line up with the
    // request the daemon is waiting on.
    expect(question?.questions[0]).toMatchObject({ id: "1", header: "Question" });
  });

  it("returns null when there is no id or nothing answerable", () => {
    expect(decodePendingQuestion({ questions: [{ question: "hi" }] }, "a")).toBeNull();
    expect(decodePendingQuestion({ id: "req-1", questions: [] }, "a")).toBeNull();
    expect(decodePendingQuestion({ id: "req-1" }, "a")).toBeNull();
    expect(decodePendingQuestion(null, "a")).toBeNull();
  });
});

describe("decodeQuestionRequestId", () => {
  it("accepts either spelling the daemon uses", () => {
    expect(decodeQuestionRequestId({ requestID: "r1" })).toBe("r1");
    expect(decodeQuestionRequestId({ id: "r2" })).toBe("r2");
    expect(decodeQuestionRequestId({})).toBeNull();
  });
});

describe("upsertPendingQuestion / removePendingQuestion", () => {
  const make = (id: string): PendingAcpQuestion => ({
    id,
    agentActorId: "agent-1",
    questions: [
      { id: "0", header: "Question", question: id, options: [], allowsMultiple: false },
    ],
  });

  it("appends new ids and replaces a re-ask in place", () => {
    const first = upsertPendingQuestion([], make("a"));
    const both = upsertPendingQuestion(first, make("b"));
    expect(both.map((q) => q.id)).toEqual(["a", "b"]);

    const reasked = { ...make("a"), agentActorId: "agent-2" };
    const replaced = upsertPendingQuestion(both, reasked);
    expect(replaced.map((q) => q.id)).toEqual(["a", "b"]);
    expect(replaced[0].agentActorId).toBe("agent-2");
  });

  it("removes by request id", () => {
    const pending = [make("a"), make("b")];
    expect(removePendingQuestion(pending, "a").map((q) => q.id)).toEqual(["b"]);
    expect(removePendingQuestion(pending, "zz")).toHaveLength(2);
  });
});

describe("buildQuestionAnswers", () => {
  const questions = [
    { id: "0", header: "H", question: "Q1", options: [], allowsMultiple: true },
    { id: "1", header: "H", question: "Q2", options: [], allowsMultiple: false },
  ];

  it("sorts selections and lets a typed answer win", () => {
    const answers = buildQuestionAnswers(
      questions,
      { "0": ["zed", "alpha"], "1": ["ignored"] },
      { "1": "  custom  " },
    );
    expect(answers).toEqual([["alpha", "zed"], ["custom"]]);
    expect(areAnswersComplete(answers)).toBe(true);
  });

  it("reports incomplete when a question has no answer", () => {
    const answers = buildQuestionAnswers(questions, { "0": ["a"] }, {});
    expect(answers).toEqual([["a"], []]);
    expect(areAnswersComplete(answers)).toBe(false);
    expect(areAnswersComplete([])).toBe(false);
  });
});
