// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TrendingView } from "./TrendingView";
import { fetchTrending } from "./trendingFetch";
import type { NewsActions } from "./newsActions";

vi.mock("./trendingFetch", () => ({ fetchTrending: vi.fn() }));
vi.mock("../../utils/cache", () => ({
  getCachedData: () => null,
  setCachedData: vi.fn(),
  fetchWithRetry: (fn: () => Promise<unknown>) => fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

it("calls the adapter and renders its errors with a working retry", async () => {
  vi.mocked(fetchTrending).mockRejectedValue(new Error("网络请求失败，请检查网络后重试"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<TrendingView actions={{} as NewsActions} />); });
  expect(fetchTrending).toHaveBeenCalledWith("weibo", false);
  expect(container.textContent).toContain("网络请求失败，请检查网络后重试");
  expect(container.textContent).not.toContain("Load failed");
  const calls = vi.mocked(fetchTrending).mock.calls.length;
  const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重试");
  expect(retry).toBeDefined();
  await act(async () => { retry!.click(); });
  expect(vi.mocked(fetchTrending).mock.calls.length).toBe(calls + 1);
  await act(async () => root.unmount());
  container.remove();
});
