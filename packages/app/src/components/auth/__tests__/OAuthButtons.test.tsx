import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn() }));
vi.mock("@/lib/utils", async (orig) => ({ ...(await orig<object>()), isTauri: isTauriMock }));
vi.mock("@/lib/build-config", async (importOriginal) => {
  const actual = await importOriginal<{ buildConfig: Record<string, unknown> }>();
  return {
    ...actual,
    buildConfig: {
      ...actual.buildConfig,
      features: {
        ...(actual.buildConfig.features as Record<string, unknown>),
        auth: { google: true, wechat: true, webSSO: true },
      },
    },
  };
});

import { OAuthButtons } from "../LoginScreen";

beforeEach(() => isTauriMock.mockReset());
afterEach(() => act(() => useAuthStore.setState({ oauthPending: null })));

describe("OAuthButtons", () => {
  it("renders WeChat + Google buttons in Tauri when both flags on", () => {
    isTauriMock.mockReturnValue(true);
    render(<OAuthButtons />);
    // Test env runs zh-CN — assert Chinese labels.
    expect(screen.getByText("使用微信登录")).toBeTruthy();
    expect(screen.getByText("使用 Google 登录")).toBeTruthy();
  });

  it("renders 快捷登录 button when features.auth.webSSO is on", () => {
    isTauriMock.mockReturnValue(true);
    render(<OAuthButtons />);
    expect(screen.getByText("快捷登录")).toBeTruthy();
  });

  it("renders nothing on web (non-Tauri)", () => {
    isTauriMock.mockReturnValue(false);
    const { container } = render(<OAuthButtons />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a cancel control instead of provider buttons while OAuth is pending", () => {
    isTauriMock.mockReturnValue(true);
    const cancelOAuth = vi.fn();
    act(() => useAuthStore.setState({ oauthPending: "google", cancelOAuth }));
    render(<OAuthButtons />);
    // Provider buttons are replaced by the waiting + cancel affordance.
    expect(screen.queryByText("使用 Google 登录")).toBeNull();
    expect(screen.queryByText("使用微信登录")).toBeNull();
    const cancel = screen.getByText("取消并换一种方式");
    fireEvent.click(cancel);
    expect(cancelOAuth).toHaveBeenCalledTimes(1);
  });

  it("shows webSSO waiting message + cancel while webSsoPending is true", () => {
    isTauriMock.mockReturnValue(true);
    const cancelWebSso = vi.fn();
    act(() => useAuthStore.setState({ webSsoPending: true, cancelWebSso }));
    render(<OAuthButtons />);
    // Provider buttons replaced by webSSO waiting affordance.
    expect(screen.queryByText("使用 Google 登录")).toBeNull();
    expect(screen.getByText("在窗口里登录完成后回到这里。")).toBeTruthy();
    const cancel = screen.getByText("取消并换一种方式");
    fireEvent.click(cancel);
    expect(cancelWebSso).toHaveBeenCalledTimes(1);
  });
});
