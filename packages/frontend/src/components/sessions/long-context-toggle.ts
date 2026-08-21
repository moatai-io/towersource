const LONG_CONTEXT_TOGGLE_TIMEOUT_MS = 10_000;

export async function saveLongContextModel(
  sessionId: string,
  modelUsed: string,
  options: {
    token?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LONG_CONTEXT_TOGGLE_TIMEOUT_MS,
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ modelUsed }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("롱컨텍스트 설정 요청 시간이 초과되었습니다.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
