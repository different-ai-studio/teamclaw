import { beforeEach, describe, expect, it } from "vitest";

import type { UploadedAttachment } from "../features/sessions/attachment-upload";

const sample: UploadedAttachment = {
  path: "t1/s1/abc.png",
  publicUrl: "https://example.test/t1/s1/abc.png",
  mime: "image/png",
  size: 1024,
};

beforeEach(async () => {
  // Drain the module-level registry between cases.
  const mod = await import("../features/sessions/pending-attachments");
  mod.takePendingAttachments("t1", "s1");
  mod.takePendingAttachments("t1", "s2");
  mod.takePendingAttachments("t2", "s1");
});

describe("pending-attachments registry", () => {
  it("appends + drains per team/session key", async () => {
    const { appendPendingAttachment, takePendingAttachments } = await import(
      "../features/sessions/pending-attachments"
    );
    appendPendingAttachment("t1", "s1", sample);
    appendPendingAttachment("t1", "s1", { ...sample, path: "second.png" });
    appendPendingAttachment("t1", "s2", { ...sample, path: "other.png" });

    expect(takePendingAttachments("t1", "s1")).toHaveLength(2);
    expect(takePendingAttachments("t1", "s1")).toHaveLength(0);
    expect(takePendingAttachments("t1", "s2")).toHaveLength(1);
  });

  it("peek does not drain", async () => {
    const { appendPendingAttachment, peekPendingAttachments, takePendingAttachments } =
      await import("../features/sessions/pending-attachments");
    appendPendingAttachment("t2", "s1", sample);
    expect(peekPendingAttachments("t2", "s1")).toHaveLength(1);
    expect(peekPendingAttachments("t2", "s1")).toHaveLength(1);
    expect(takePendingAttachments("t2", "s1")).toHaveLength(1);
    expect(peekPendingAttachments("t2", "s1")).toHaveLength(0);
  });

  it("exposes stable snapshots for UI subscribers", async () => {
    const { appendPendingAttachment, getPendingAttachmentSnapshot } =
      await import("../features/sessions/pending-attachments");

    const emptyA = getPendingAttachmentSnapshot("t1", "s1");
    const emptyB = getPendingAttachmentSnapshot("t1", "s1");
    expect(emptyA).toBe(emptyB);

    appendPendingAttachment("t1", "s1", sample);
    const filledA = getPendingAttachmentSnapshot("t1", "s1");
    const filledB = getPendingAttachmentSnapshot("t1", "s1");
    expect(filledA).toBe(filledB);
    expect(filledA).toEqual([sample]);
  });

  it("removes one pending attachment by path", async () => {
    const {
      appendPendingAttachment,
      getPendingAttachmentSnapshot,
      removePendingAttachment,
    } = await import("../features/sessions/pending-attachments");
    appendPendingAttachment("t1", "s1", sample);
    appendPendingAttachment("t1", "s1", { ...sample, path: "second.png" });

    removePendingAttachment("t1", "s1", sample.path);

    expect(getPendingAttachmentSnapshot("t1", "s1")).toEqual([
      { ...sample, path: "second.png" },
    ]);
  });

  it("notifies subscribers on append + take", async () => {
    const {
      appendPendingAttachment,
      subscribePendingAttachments,
      takePendingAttachments,
    } = await import("../features/sessions/pending-attachments");
    const calls: string[] = [];
    const unsubscribe = subscribePendingAttachments((key) => calls.push(key));
    appendPendingAttachment("t1", "s1", sample);
    takePendingAttachments("t1", "s1");
    unsubscribe();
    expect(calls).toEqual(["t1:s1", "t1:s1"]);
  });
});
