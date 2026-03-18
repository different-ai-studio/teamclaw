import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutoSave } from "../useAutoSave";

// Mock Tauri writeTextFile
const mockWriteTextFile = vi.fn().mockResolvedValue(undefined);

// Mock the dynamic import of @tauri-apps/plugin-fs
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
}));

// Mock sonner toast
const mockToastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    info: vi.fn(),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  mockWriteTextFile.mockClear();
  mockWriteTextFile.mockResolvedValue(undefined);
  mockToastError.mockClear();
  // Simulate Tauri environment
  Object.defineProperty(window, "__TAURI__", {
    value: true,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAutoSave", () => {
  // 9.1
  it("triggers save after 1s idle", async () => {
    const { rerender } = renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "initial",
          isModified: false,
          enabled: true,
        },
      },
    );

    // Simulate content change
    rerender({
      filePath: "/test/file.md",
      content: "modified content",
      isModified: true,
      enabled: true,
    });

    // Should not have saved yet
    expect(mockWriteTextFile).not.toHaveBeenCalled();

    // Advance past debounce delay and flush promises
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(mockWriteTextFile).toHaveBeenCalledWith(
      "/test/file.md",
      "modified content",
    );
  });

  // 9.2
  it("debounce resets on continued input — no save while typing", async () => {
    const { rerender } = renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "v1",
          isModified: true,
          enabled: true,
        },
      },
    );

    // Simulate rapid typing
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({
      filePath: "/test/file.md",
      content: "v2",
      isModified: true,
      enabled: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    rerender({
      filePath: "/test/file.md",
      content: "v3",
      isModified: true,
      enabled: true,
    });

    // Should not have saved yet (timer kept resetting)
    expect(mockWriteTextFile).not.toHaveBeenCalled();

    // Now wait 1s after last change
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Should save with latest content
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    expect(mockWriteTextFile).toHaveBeenCalledWith("/test/file.md", "v3");
  });

  // 9.3
  it("does not save when content is unchanged", async () => {
    renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "same",
          isModified: false, // not modified
          enabled: true,
        },
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  // 9.4
  it("transitions save status: saved → modified → saving → saved", async () => {
    // Use real timers for this test since we call saveNow() directly
    vi.useRealTimers();

    const { result, rerender } = renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "initial",
          isModified: false,
          enabled: true,
        },
      },
    );

    // Initial state should be "saved"
    expect(result.current.saveStatus).toBe("saved");

    // Change content → should transition to "modified"
    await act(async () => {
      rerender({
        filePath: "/test/file.md",
        content: "changed",
        isModified: true,
        enabled: true,
      });
    });

    expect(result.current.saveStatus).toBe("modified");

    // Use saveNow() to trigger save immediately (bypasses debounce)
    await act(async () => {
      await result.current.saveNow();
    });

    // writeTextFile should have been called
    expect(mockWriteTextFile).toHaveBeenCalledWith("/test/file.md", "changed");

    // After save, the parent would set isModified=false
    // The hook resets to "modified" if isModified is still true
    await act(async () => {
      rerender({
        filePath: "/test/file.md",
        content: "changed",
        isModified: false,
        enabled: true,
      });
    });

    // Now status should be "saved"
    expect(result.current.saveStatus).toBe("saved");

    // Restore fake timers for remaining tests
    vi.useFakeTimers();
  });

  // 9.5
  it("reverts to modified on save error and shows toast", async () => {
    mockWriteTextFile.mockRejectedValueOnce(new Error("Write failed"));

    const { result } = renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "will-fail",
          isModified: true,
          enabled: true,
        },
      },
    );

    // Advance past debounce to fire the setTimeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // doSave is fire-and-forget from setTimeout, so the async rejection
    // (hashContent + writeTextFile) may not have settled yet.
    // Switch to real timers so waitFor's polling works, then wait for
    // the status to revert from 'saving' to 'modified'.
    vi.useRealTimers();

    await waitFor(() => {
      expect(result.current.saveStatus).toBe("modified");
    });
    expect(mockToastError).toHaveBeenCalled();

    // Restore fake timers for the afterEach cleanup
    vi.useFakeTimers();
  });

  // 9.6
  it("isSelfWrite returns true for matching content hash", async () => {
    const { result } = renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "test content",
          isModified: true,
          enabled: true,
        },
      },
    );

    // Trigger save
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Check if the same content is detected as self-write
    let isSelf = false;
    await act(async () => {
      isSelf = await result.current.isSelfWrite("test content");
    });

    expect(isSelf).toBe(true);
  });

  // 9.7
  it("isSelfWrite returns false for non-matching content (agent write)", async () => {
    const { result } = renderHook(
      (props) => useAutoSave(props),
      {
        initialProps: {
          filePath: "/test/file.md",
          content: "my content",
          isModified: true,
          enabled: true,
        },
      },
    );

    // Trigger save
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // Check with different content (agent wrote something different)
    let isSelf = false;
    await act(async () => {
      isSelf = await result.current.isSelfWrite("agent wrote this");
    });

    expect(isSelf).toBe(false);
  });
});
