// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLongContextModel } from "./long-context-toggle";

describe("saveLongContextModel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists the selected model with auth and clears its timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await saveLongContextModel("session-1", "litellm-responses/smartest-long", {
      token: "test-token",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1", expect.objectContaining({
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ modelUsed: "litellm-responses/smartest-long" }),
      signal: expect.any(AbortSignal),
    }));
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces the backend error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: "modelUsed does not match session engine" }),
    }));

    await expect(saveLongContextModel("session-1", "bad-model"))
      .rejects.toThrow("modelUsed does not match session engine");
  });

  it("aborts an unresponsive request and returns a timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    const request = saveLongContextModel("session-1", "litellm-responses/smartest-long", {
      timeoutMs: 25,
    });
    const assertion = expect(request).rejects.toThrow("롱컨텍스트 설정 요청 시간이 초과되었습니다.");

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});
