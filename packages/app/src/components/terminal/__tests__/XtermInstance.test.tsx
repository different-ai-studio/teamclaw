import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  subscribeMock,
  onDataMock,
  onExitMock,
  resizeMock,
  writeMock,
  closeMock,
  xtermWriteMock,
  xtermDisposeMock,
} = vi.hoisted(() => ({
  subscribeMock: vi.fn(async () => ({
    ring_snapshot: [104, 105, 10], // "hi\n"
    cols: 80,
    rows: 24,
    status: "running",
    exit_code: null,
  })),
  onDataMock: vi.fn(async () => () => {}),
  onExitMock: vi.fn(async () => () => {}),
  resizeMock: vi.fn(async () => {}),
  writeMock: vi.fn(async () => {}),
  closeMock: vi.fn(async () => {}),
  xtermWriteMock: vi.fn(),
  xtermDisposeMock: vi.fn(),
}));

vi.mock("@/lib/terminal/client", () => ({
  subscribeTerminal: subscribeMock,
  onTerminalData: onDataMock,
  onTerminalExit: onExitMock,
  resizeTerminal: resizeMock,
  writeTerminal: writeMock,
  closeTerminal: closeMock,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(function () {
    return {
      open: vi.fn(),
      write: xtermWriteMock,
      dispose: xtermDisposeMock,
      loadAddon: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      focus: vi.fn(),
      options: {},
    }
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    }
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function () { return {} }),
}));

import { XtermInstance } from "@/components/terminal/XtermInstance";

describe("XtermInstance", () => {
  beforeEach(() => {
    subscribeMock.mockClear();
    subscribeMock.mockResolvedValue({
      ring_snapshot: [104, 105, 10], // "hi\n"
      cols: 80,
      rows: 24,
      status: "running",
      exit_code: null,
    });
    onDataMock.mockClear();
    onDataMock.mockResolvedValue(() => {});
    xtermWriteMock.mockClear();
    xtermDisposeMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(() => cleanup());

  test("on mount: subscribes and replays ring", async () => {
    render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    expect(subscribeMock).toHaveBeenCalledWith("t1");
    // ring replay
    expect(xtermWriteMock).toHaveBeenCalled();
  });

  test("on unmount: disposes xterm but does NOT call terminal_close", async () => {
    const { unmount } = render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    unmount();
    expect(xtermDisposeMock).toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  test("catches prompt output emitted between initial snapshot and data listener registration", async () => {
    subscribeMock
      .mockResolvedValueOnce({
        ring_snapshot: [],
        cols: 80,
        rows: 24,
        status: "running",
        exit_code: null,
      })
      .mockResolvedValueOnce({
        ring_snapshot: [37, 32], // "% "
        cols: 80,
        rows: 24,
        status: "running",
        exit_code: null,
      });

    render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));

    expect(onDataMock).toHaveBeenCalledWith("t1", expect.any(Function));
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(xtermWriteMock).toHaveBeenCalledWith(new Uint8Array([37, 32]));
  });
});
