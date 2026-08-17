// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import i18n from "../../i18n";
import { MessageBubble, TurnMetricsBar } from "./MessageBubble";
import { useChatStore, type ChatMessage } from "../../stores/chat-store";
import { useSessionStore } from "../../stores/session-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
  cacheSessionMessages,
  sessionMsgCache,
} from "../../utils/session-message-cache";

beforeEach(async () => {
  await i18n.changeLanguage("ko");
  localStorage.clear();
  useChatStore.setState({
    isStreaming: false,
    sessionId: null,
    engineSessionId: null,
    messages: [],
    slashCommands: [],
    attachments: [],
    messageQueue: {},
    turnStartTime: null,
    lastTurnMetrics: null,
    turnStateBySession: {},
  });
  useSessionStore.setState({
    activeSessionId: null,
    streamingSessions: new Set(),
    lastTurnTextBySession: {},
  });
  useSettingsStore.setState({
    serverConfig: { turnRewindEnabled: true },
  } as any);
  sessionMsgCache.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MessageBubble user inline edit", () => {
  it("turns a stored user message without sendStatus into an inline editor", () => {
    useChatStore.setState({ sessionId: "session-1" });
    useSessionStore.setState({
      activeSessionId: "session-1",
      sessions: [{ id: "session-1", name: "원본", visibility: "project" }],
    } as any);
    const message: ChatMessage = {
      id: "message-stored-1",
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: "저장된 기존 요청입니다." }],
    };

    render(<MessageBubble message={message} />);

    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    expect(
      screen.getByRole("textbox", { name: "수정할 요청 내용" }),
    ).toHaveValue("저장된 기존 요청입니다.");
  });

  it("turns a delivered user message into an inline editor with cancel and send actions", () => {
    useChatStore.setState({ sessionId: "session-1" });
    useSessionStore.setState({
      activeSessionId: "session-1",
      sessions: [{ id: "session-1", name: "원본", visibility: "project" }],
    } as any);
    const message: ChatMessage = {
      id: "message-1",
      role: "user",
      timestamp: Date.now(),
      sendStatus: "delivered",
      content: [{ type: "text", text: "원래 요청입니다." }],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByRole("button", { name: "수정" })).toBeInTheDocument();
    const linkButton = screen.getByRole("button", { name: "메시지 링크 복사" });
    const copyButton = screen.getByRole("button", { name: "메시지 복사" });
    expect(linkButton).toBeInTheDocument();
    expect(copyButton).toBeInTheDocument();
    expect(linkButton).toHaveClass("md:min-w-fit", "md:shrink-0");
    expect(copyButton).toHaveClass("md:min-w-fit", "md:shrink-0");
    expect(linkButton.querySelector("span")).toHaveClass("whitespace-nowrap");
    expect(copyButton.querySelector("span")).toHaveClass("whitespace-nowrap");

    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    expect(
      screen.getByRole("textbox", { name: "수정할 요청 내용" }),
    ).toHaveValue("원래 요청입니다.");
    expect(screen.queryByText("원본은 유지됩니다.")).toBeNull();
    expect(screen.getByRole("button", { name: "취소" })).toHaveTextContent("×");
    expect(
      screen.getByRole("button", { name: "다시 보내기" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "새 대화에서 보내기" }),
    ).toBeInTheDocument();
  });

  it("sends the edited prompt to a new branch session", async () => {
    useChatStore.setState({ sessionId: "session-1" });
    useSessionStore.setState({
      activeSessionId: "session-1",
      sessions: [{ id: "session-1", name: "원본", visibility: "project" }],
    } as any);
    const session = {
      id: "child-edit",
      name: "원본 (과거에서 다시 시작)",
      cwd: "/workspace",
      tags: [],
      favorite: false,
      totalCost: 0,
      totalTokens: 0,
      createdAt: "",
      updatedAt: "",
      visibility: "project",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          session,
          mode: "edit_and_resend",
          draft: "원래 요청입니다.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const replay = vi.fn();
    window.addEventListener("tower-replay-branch-prompt", replay);
    const message: ChatMessage = {
      id: "message-1",
      role: "user",
      timestamp: Date.now(),
      sendStatus: "delivered",
      content: [{ type: "text", text: "원래 요청입니다." }],
    };

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "수정할 요청 내용" }),
      { target: { value: "수정한 요청입니다." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "새 대화에서 보내기" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/session-1/messages/message-1/branch",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ mode: "edit_and_resend" }),
        }),
      ),
    );
    await waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect((replay.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: "child-edit",
      prompt: "수정한 요청입니다.",
      cwd: "/workspace",
    });
    window.removeEventListener("tower-replay-branch-prompt", replay);
  });

  it("rewinds the current session and resends the edited prompt", async () => {
    useChatStore.setState({
      sessionId: "session-1",
      messages: [
        {
          id: "before-user",
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: "이전 요청" }],
        },
        {
          id: "before-assistant",
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "이전 답변" }],
        },
        {
          id: "message-1",
          role: "user",
          timestamp: Date.now(),
          sendStatus: "delivered",
          content: [{ type: "text", text: "원래 요청입니다." }],
        },
        {
          id: "after-assistant",
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "이후 답변" }],
        },
      ] as ChatMessage[],
    });
    useSessionStore.setState({
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          name: "원본",
          cwd: "/workspace",
          visibility: "project",
        },
      ],
    } as any);
    cacheSessionMessages("session-1", useChatStore.getState().messages);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          session: { id: "session-1", cwd: "/workspace" },
          replayPrompt: "원래 요청입니다.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const replay = vi.fn();
    window.addEventListener("tower-replay-branch-prompt", replay);
    const message = useChatStore.getState().messages[2];

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "수정할 요청 내용" }),
      { target: { value: "수정한 요청입니다." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "다시 보내기" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/session-1/messages/message-1/rewind-replay",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      ),
    );
    await waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(useChatStore.getState().messages.map((item) => item.id)).toEqual([
      "before-user",
      "before-assistant",
    ]);
    expect(sessionMsgCache.get("session-1")?.map((item) => item.id)).toEqual([
      "before-user",
      "before-assistant",
    ]);
    expect((replay.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: "session-1",
      prompt: "수정한 요청입니다.",
      cwd: "/workspace",
    });
    window.removeEventListener("tower-replay-branch-prompt", replay);
  });
});

describe("MessageBubble user file path links", () => {
  it("links a bare portable workspace HTML path in a user message", () => {
    const path =
      "~/workspace/projects/company-profile/work/agent-first-tower-prototype-v2/index.html";
    const onFileClick = vi.fn();
    const message: ChatMessage = {
      id: "user-file-path-1",
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: `지금은 ${path} 이런걸 누르면` }],
    };

    render(<MessageBubble message={message} onFileClick={onFileClick} />);

    const link = screen.getByRole("button", { name: `파일 열기: ${path}` });
    expect(link).toHaveTextContent(path);
    fireEvent.click(link);
    expect(onFileClick).toHaveBeenCalledWith(path);
  });

  it("opens a session attachment from the user bubble through the attachment callback", async () => {
    const path = "session://attachments/11111111-1111-4111-8111-111111111111";
    const onFileClick = vi.fn();
    localStorage.setItem("token", "shared-session-token");
    useChatStore.setState({ sessionId: "session-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          attachment: { name: "team.png", mimeType: "image/png" },
        }),
      }),
    );
    const message: ChatMessage = {
      id: "user-file-tag-1",
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: `[file: ${path}]` }],
    };

    render(<MessageBubble message={message} onFileClick={onFileClick} />);

    const image = await screen.findByAltText("team.png");
    expect(image).toHaveAttribute(
      "src",
      "/api/session-attachments/session-1/11111111-1111-4111-8111-111111111111/content?token=shared-session-token",
    );
    fireEvent.click(image);
    expect(onFileClick).toHaveBeenCalledWith(path);
    vi.unstubAllGlobals();
  });
});

describe("MessageBubble artifact-backed Markdown card", () => {
  it("renders a saved artifact as a plain clickable file path link", () => {
    const onFileClick = vi.fn();
    const path = "~/workspace/projects/demo/work/report.md";
    const message: ChatMessage = {
      id: "assistant-artifact-card-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "artifact_markdown",
          title: "Report",
          text: "# Report\n\n본문입니다.",
          path: "work/report.md",
          portablePath: path,
          status: "saved",
          sha256: "abc123456789",
        },
      ],
    };

    render(<MessageBubble message={message} onFileClick={onFileClick} />);

    expect(screen.getByRole("heading", { name: "Report" })).toBeInTheDocument();
    expect(screen.queryByText("파일로도 저장됨")).toBeNull();
    expect(screen.getByText("파일:")).toBeInTheDocument();
    const openButton = screen.getByRole("button", { name: `파일 열기: ${path}` });
    expect(openButton).toHaveTextContent(path);
    expect(openButton).toHaveClass("break-all", "underline", "font-mono");
    fireEvent.click(openButton);
    expect(onFileClick).toHaveBeenCalledWith(path);
  });

  it("keeps a very long artifact path inside the message width", () => {
    const longPath = `~/workspace/projects/demo/work/${"very-long-segment-".repeat(12)}report.md`;
    const message: ChatMessage = {
      id: "assistant-artifact-card-long-path",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "artifact_markdown",
          text: "# Report",
          path: `work/${"very-long-segment-".repeat(12)}report.md`,
          portablePath: longPath,
          status: "saved",
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".tone-card")).toBeNull();
    expect(screen.getByRole("button", { name: `파일 열기: ${longPath}` })).toHaveClass("break-all");
    expect(screen.getByText(longPath)).toBeInTheDocument();
  });

  it("shows warning copy only when artifact saving failed", () => {
    const message: ChatMessage = {
      id: "assistant-artifact-card-error",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "artifact_markdown",
          text: "# Report",
          path: "../outside.md",
          status: "skipped",
          error: "unsafe_or_unsupported_artifact_path",
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("파일 저장 실패")).toBeInTheDocument();
    expect(screen.getByText("unsafe_or_unsupported_artifact_path")).toBeInTheDocument();
  });
});

describe("MessageBubble thinking/tool meta row", () => {
  it("renders progress commentary like ordinary assistant prose while hiding hidden commentary", () => {
    const message: ChatMessage = {
      id: "commentary-progress-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        { type: "commentary", text: "Worker 서비스를 확인하겠습니다.", phase: "commentary", visibility: "progress" },
        { type: "commentary", text: "Need internal planning.", phase: "commentary", visibility: "hidden" },
        { type: "text", text: "완료했습니다." },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.queryByTestId("commentary-progress-bubble")).toBeNull();
    expect(screen.queryByText("진행")).toBeNull();
    expect(screen.getByText("Worker 서비스를 확인하겠습니다.")).toBeInTheDocument();
    expect(screen.queryByText("Need internal planning.")).toBeNull();
    expect(screen.getByText("완료했습니다.")).toBeInTheDocument();
  });

  it("automatically opens a Credential Vault tool group and selects its secure input", () => {
    const message: ChatMessage = {
      id: "credential-vault-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "credential-tool-1",
            name: "credential_vault_input",
            input: {
              inputType: "fields",
              id: "supabase-management",
              provider: "supabase",
              displayName: "Supabase Management API 자격증명",
              scope: "project",
              grantToCurrentProject: true,
              fields: [
                {
                  key: "SUPABASE_ACCESS_TOKEN",
                  label: "Supabase Personal Access Token",
                  required: true,
                },
                {
                  key: "SUPABASE_PROJECT_REF",
                  label: "Supabase Project Ref",
                  required: true,
                },
              ],
            },
            result: "Secure credential input opened.",
          },
        },
      ],
    };

    render(<MessageBubble message={message} isLastAssistant={true} />);

    expect(
      screen.getByPlaceholderText("SUPABASE_ACCESS_TOKEN"),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("SUPABASE_PROJECT_REF"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Vault에 저장" }),
    ).toBeInTheDocument();
  });

  it("keeps AUQ history visible when it shares a tool group with another tool", () => {
    const auqResult = JSON.stringify({
      kind: "tower.ask_user_question_result",
      status: "answered",
      answers: [
        {
          question: "배포 방식을 선택해주세요",
          selected: ["검증 후 배포"],
          answer: "검증 후 배포",
        },
      ],
    });
    const message: ChatMessage = {
      id: "mixed-auq-tool-group",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "auq-1",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "배포 방식을 선택해주세요",
                  options: [{ label: "즉시 배포" }, { label: "검증 후 배포" }],
                },
              ],
            },
            result: auqResult,
          },
        },
        {
          type: "tool_use",
          toolUse: {
            id: "bash-1",
            name: "Bash",
            input: { command: "npm test" },
            result: "ok",
          },
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(
      screen.getByTestId("ask-user-question-compact-history"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("배포 방식을 선택해주세요")[0]).toBeVisible();
    expect(screen.getAllByText("검증 후 배포")[0]).toBeVisible();
    expect(screen.getByText("도구 사용 1번")).toBeInTheDocument();
  });

  it("renders only the latest TodoWrite snapshot while work is still in progress", () => {
    const message: ChatMessage = {
      id: "todo-progress-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "첫 단계",
                  status: "in_progress",
                  activeForm: "첫 단계 진행 중",
                },
                {
                  content: "둘째 단계",
                  status: "pending",
                  activeForm: "둘째 단계 진행 중",
                },
              ],
            },
          },
        },
        {
          type: "tool_use",
          toolUse: {
            id: "todo-2",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "첫 단계",
                  status: "completed",
                  activeForm: "첫 단계 진행 중",
                },
                {
                  content: "둘째 단계",
                  status: "in_progress",
                  activeForm: "둘째 단계 진행 중",
                },
              ],
            },
          },
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.queryByText("이전 진행 상태")).toBeNull();
    expect(screen.queryByText("0/2")).toBeNull();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("첫 단계")).toBeInTheDocument();
    expect(screen.getByText("둘째 단계")).toBeInTheDocument();
  });

  it("can hide stale TodoWrite snapshots after the live assistant turn moves on", () => {
    const message: ChatMessage = {
      id: "todo-stale-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "첫 단계",
                  status: "completed",
                  activeForm: "첫 단계 진행 중",
                },
                {
                  content: "둘째 단계",
                  status: "in_progress",
                  activeForm: "둘째 단계 진행 중",
                },
              ],
            },
          },
        },
      ],
    };

    render(<MessageBubble message={message} showTodoSnapshots={false} />);

    expect(screen.queryByText("1/2")).toBeNull();
    expect(screen.queryByText("첫 단계")).toBeNull();
    expect(screen.queryByText("둘째 단계")).toBeNull();
  });

  it("hides all TodoWrite snapshots once the latest todo state is fully completed", () => {
    const message: ChatMessage = {
      id: "todo-complete-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "첫 단계",
                  status: "completed",
                  activeForm: "첫 단계 진행 중",
                },
                {
                  content: "둘째 단계",
                  status: "in_progress",
                  activeForm: "둘째 단계 진행 중",
                },
              ],
            },
          },
        },
        {
          type: "tool_use",
          toolUse: {
            id: "todo-2",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "첫 단계",
                  status: "completed",
                  activeForm: "첫 단계 진행 중",
                },
                {
                  content: "둘째 단계",
                  status: "completed",
                  activeForm: "둘째 단계 진행 중",
                },
              ],
            },
          },
        },
        { type: "text", text: "작업 완료" },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("작업 완료")).toBeInTheDocument();
    expect(screen.queryByText("이전 진행 상태")).toBeNull();
    expect(screen.queryByText("첫 단계")).toBeNull();
    expect(screen.queryByText("둘째 단계")).toBeNull();
    expect(screen.queryByText("2/2")).toBeNull();
  });

  it("renders a thinking chip and tool chip without exposing raw thinking content", () => {
    const message: ChatMessage = {
      id: "m1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "thinking",
          thinking: {
            text: "**Considering signature inspection**\n\nI'm thinking about the next step.",
          },
        },
        {
          type: "tool_use",
          toolUse: {
            id: "tool-1",
            name: "Bash",
            input: { command: "ls -la" },
          },
        },
      ],
    };

    render(<MessageBubble message={message} />);

    // Thinking chip renders the extracted title as a compact signal.
    expect(
      screen.getByText("Considering signature inspection"),
    ).toBeInTheDocument();
    // Raw thinking body must not be visible in the transcript.
    expect(screen.queryByText(/I'm thinking about the next step/)).toBeNull();
    // Collapsed tool group renders a localized activity summary.
    expect(screen.getByText("도구 사용 1번")).toBeInTheDocument();
  });

  it("renders the live thinking chip when only reasoning token metadata is available", () => {
    const message: ChatMessage = {
      id: "m-reasoning",
      role: "assistant",
      timestamp: Date.now(),
      reasoningTokens: 1234,
      content: [{ type: "text", text: "완료했습니다." }],
    };

    render(<MessageBubble message={message} isLastAssistant={true} />);

    expect(screen.getByText("생각 중")).toBeInTheDocument();
    expect(screen.getByText("완료했습니다.")).toBeInTheDocument();
  });

  it("places assistant link and copy actions after the answer without overlaying the prose", () => {
    useSessionStore.setState({
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          name: "대화",
          shortCode: "chat-1",
          visibility: "project",
        },
      ],
    } as any);
    const message: ChatMessage = {
      id: "assistant-footer-actions",
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: "답변 본문 마지막 문장입니다." }],
    };

    render(<MessageBubble message={message} />);

    const prose = screen.getByText("답변 본문 마지막 문장입니다.");
    const actions = screen.getByTestId("assistant-message-actions");
    expect(actions).not.toHaveClass("absolute");
    expect(actions).toHaveClass(
      "justify-end",
      "md:opacity-0",
      "md:group-hover/message:opacity-100",
      "md:group-focus-within/message:opacity-100",
    );
    expect(
      prose.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "메시지 링크 복사" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "메시지 복사" }),
    ).toBeInTheDocument();
  });

  it("stacks assistant identity above the message body on mobile width", () => {
    const message: ChatMessage = {
      id: "assistant-mobile-layout",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: "모바일에서는 본문이 아이콘 열에 눌리지 않아야 합니다.",
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} />);
    const row = container.querySelector(
      '[data-message-id="assistant-mobile-layout"]',
    );
    const body = row?.querySelector(":scope > div:last-child");

    expect(row).toHaveClass("flex-col");
    expect(row).toHaveClass("md:flex-row");
    expect(body).toHaveClass("w-full");
    expect(body).toHaveClass("md:flex-1");
  });

  it("renders tool and thinking chrome in English when language is English", async () => {
    await i18n.changeLanguage("en");
    const message: ChatMessage = {
      id: "m-en",
      role: "assistant",
      timestamp: Date.now(),
      reasoningTokens: 1234,
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "tool-en-1",
            name: "Bash",
            input: { command: "npm test" },
          },
        },
      ],
    };

    render(<MessageBubble message={message} isLastAssistant={true} />);

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("1 tool uses")).toBeInTheDocument();
  });

  it("hides stale empty thinking placeholders while keeping adjacent tool chips static", () => {
    useChatStore.setState({ isStreaming: true, sessionId: "s1" });
    useSessionStore.setState({
      activeSessionId: "s1",
      streamingSessions: new Set(["s1"]),
    });
    const message: ChatMessage = {
      id: "old-assistant",
      role: "assistant",
      timestamp: Date.now() - 10_000,
      content: [
        { type: "thinking", thinking: { text: "" } },
        {
          type: "tool_use",
          toolUse: {
            id: "old-tool",
            name: "Bash",
            input: { command: "npm test" },
          },
        },
      ],
    };

    render(<MessageBubble message={message} isLastAssistant={false} />);

    expect(screen.queryByText("생각 중")).toBeNull();
    expect(screen.getByText("도구 사용 1번")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("테스트를 실행하고 있습니다")).toBeNull();
  });

  it("keeps non-live thinking chips when they contain a meaningful title", () => {
    const message: ChatMessage = {
      id: "old-assistant-with-thinking-title",
      role: "assistant",
      timestamp: Date.now() - 10_000,
      content: [
        {
          type: "thinking",
          thinking: { text: "", title: "Considering signature inspection" },
        },
        { type: "text", text: "완료했습니다." },
      ],
    };

    render(<MessageBubble message={message} isLastAssistant={false} />);

    expect(
      screen.getByText("Considering signature inspection"),
    ).toBeInTheDocument();
    expect(screen.getByText("완료했습니다.")).toBeInTheDocument();
  });
});

describe("MessageBubble skill invocation chip", () => {
  it("renders a persistent used-skill chip for user skill invocation metadata", () => {
    const message: ChatMessage = {
      id: "skill-user-1",
      role: "user",
      timestamp: Date.now(),
      username: "alice",
      metadata: {
        skillInvocation: {
          skillName: "meeting-prep",
          displayName: "회의 준비",
          trigger: "slash",
          matchedAlias: "/회의준비",
          source: "project",
        },
      },
      content: [{ type: "text", text: "/회의준비 내일 고객 미팅" }],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText(/Skill ·/)).toHaveTextContent("Skill · 회의 준비");
    expect(
      screen.getByTitle("Skill used: meeting-prep via /회의준비"),
    ).toHaveTextContent("· /회의준비");
  });
  it("renders a persistent used-skill chip for assistant skill invocation metadata", () => {
    const message: ChatMessage = {
      id: "skill-assistant-1",
      role: "assistant",
      timestamp: Date.now(),
      metadata: {
        skillInvocation: {
          skillName: "meeting-prep",
          displayName: "회의 준비",
          trigger: "slash",
          matchedAlias: "/회의준비",
          source: "project",
        },
      },
      content: [{ type: "text", text: "회의 준비안을 정리했습니다." }],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText(/Skill ·/)).toHaveTextContent("Skill · 회의 준비");
    expect(
      screen.getByTitle("Skill used: meeting-prep via /회의준비"),
    ).toHaveTextContent("· /회의준비");
    expect(screen.getByText("회의 준비안을 정리했습니다.")).toBeInTheDocument();
  });
});

describe("MessageBubble speaker attribution", () => {
  it("renders a visible speaker badge for user messages with username", () => {
    const message: ChatMessage = {
      id: "user-speaker-1",
      role: "user",
      timestamp: Date.now(),
      username: "alice",
      content: [{ type: "text", text: "공유 세션에서 보낸 메시지입니다." }],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByTitle("발화자: alice")).toBeInTheDocument();
  });

  it("keeps quiet speaker attribution visible even when rendered as a continuation", () => {
    const message: ChatMessage = {
      id: "user-speaker-2",
      role: "user",
      timestamp: Date.now(),
      username: "alice",
      content: [{ type: "text", text: "연속 메시지입니다." }],
    };

    render(<MessageBubble message={message} isContinuation />);

    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull();
    expect(screen.getByText("연속 메시지입니다.")).toBeInTheDocument();
  });

  it("falls back to the current user identity only for local in-flight messages without username", () => {
    localStorage.setItem("username", "dev");
    const message: ChatMessage = {
      id: "user-speaker-3",
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: "username 없는 live 메시지입니다." }],
      sendStatus: "pending",
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByTitle("발화자: dev")).toBeInTheDocument();
  });

  it("falls back to the session owner for persisted user messages without username", () => {
    localStorage.setItem("username", "viewer");
    useChatStore.setState({ sessionId: "s-owner-fallback" });
    useSessionStore.setState({
      sessions: [
        {
          id: "s-owner-fallback",
          name: "Shared session",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          totalTokens: 0,
          ownerUsername: "owner-user",
        } as any,
      ],
    });
    const message: ChatMessage = {
      id: "user-speaker-4",
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: "예전 메시지입니다." }],
      sendStatus: "delivered",
    };

    render(<MessageBubble message={message} />);

    expect(screen.queryByText("viewer")).toBeNull();
    expect(screen.getByText("owner-user")).toBeInTheDocument();
    expect(screen.getByText("예전 메시지입니다.")).toBeInTheDocument();
  });
});

describe("TurnMetricsBar lifecycle", () => {
  it("renders live elapsed time from active turn state without a message bubble owner", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T11:00:03.000Z"));
    useChatStore.setState({
      sessionId: "s1",
      turnStartTime: new Date("2026-06-14T11:00:00.000Z").getTime(),
      turnStateBySession: {
        s1: {
          phase: "preparing",
          startedAt: new Date("2026-06-14T11:00:00.000Z").getTime(),
          lastActivityAt: new Date("2026-06-14T11:00:03.000Z").getTime(),
          pendingMessageCount: 0,
        },
      },
    });
    useSessionStore.setState({
      streamingSessions: new Set(["s1"]),
    });

    render(<TurnMetricsBar />);

    expect(screen.getByText("3.0s")).toBeInTheDocument();
  });

  it("normalizes rounded duration across minute boundaries", () => {
    const message: ChatMessage = {
      id: "duration-boundary",
      role: "assistant",
      timestamp: Date.now() - 120_000,
      durationMs: 119_600,
      inputTokens: 100,
      outputTokens: 20,
      content: [{ type: "text", text: "완료 응답입니다." }],
    };

    render(<MessageBubble message={message} showMetrics />);

    expect(screen.getByText("2m 0s")).toBeInTheDocument();
    expect(screen.queryByText("1m 60s")).toBeNull();
  });

  it("hides completion clock on completed bubbles while a newer turn is streaming", () => {
    useChatStore.setState({
      sessionId: "s1",
      turnStartTime: Date.now() - 1000,
      turnStateBySession: {
        s1: {
          phase: "streaming",
          startedAt: Date.now() - 1000,
          lastActivityAt: Date.now(),
          pendingMessageCount: 0,
        },
      },
    });
    useSessionStore.setState({
      streamingSessions: new Set(["s1"]),
    });

    const message: ChatMessage = {
      id: "done-1",
      role: "assistant",
      timestamp: Date.now() - 60_000,
      completedAt: new Date("2026-06-14T11:36:00.000Z").getTime(),
      durationMs: 2_500,
      inputTokens: 100,
      outputTokens: 20,
      content: [{ type: "text", text: "이전 응답입니다." }],
    };

    render(<MessageBubble message={message} showMetrics />);

    expect(screen.getByText("2.5s")).toBeInTheDocument();
    expect(screen.queryByText(/완료/)).toBeNull();
  });
});

describe("MessageBubble — agent-origin run card", () => {
  function agentWorkerMessage(): ChatMessage {
    return {
      id: "agent-worker-tool-1",
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "tool_use",
          toolUse: {
            id: "tool-agent-worker-1",
            name: "mcp__agent-worker__agent_session_run_once",
            input: {
              name: "Frontend reviewer",
              task: "Review the changed UI files and summarize risks.",
            },
            result: [
              'Started run-once Agent Session "Frontend reviewer".',
              "- workerId: 37bbac76-09ff-4f62-a383-7c61e2c0ebf3",
              "- backingSessionId: 5f8bc275-283f-4218-8ccc-f6593d69e0cc",
              "- runId: 5cd428c6-936a-43b6-80a6-40f8122244cf",
              '- agentName: "Frontend reviewer"',
              '- agentRole: "UI 변경 검수"',
              '- agentFace: "🔎"',
              '- agentTagline: "사용자에게 보이는 회귀를 찾습니다"',
            ].join("\n"),
          },
        },
      ],
    };
  }

  it("renders agent-worker MCP calls as subagent run cards", () => {
    const message = agentWorkerMessage();
    useSessionStore.setState({
      lastTurnTextBySession: {
        "5f8bc275-283f-4218-8ccc-f6593d69e0cc": {
          text: "검수 완료: 문제 없음",
          updatedAt: Date.now(),
          finalized: true,
        },
      },
    });

    render(<MessageBubble message={message} />);

    expect(screen.getByText("Frontend reviewer")).toBeInTheDocument();
    expect(
      screen.getByText("사용자에게 보이는 회귀를 찾습니다"),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Frontend reviewer")).toHaveTextContent("🔎");
    expect(screen.queryByText(/run-once/)).toBeNull();
    expect(screen.getByLabelText("답변 완료")).toBeInTheDocument();
    expect(screen.queryByText("DONE")).toBeNull();
    expect(screen.queryByText("Subagent reported")).toBeNull();
    expect(screen.queryByRole("link", { name: /세션 열기/ })).toBeNull();
    expect(
      screen.getByText("Review the changed UI files and summarize risks."),
    ).toBeInTheDocument();
    expect(
      screen
        .getByText("Review the changed UI files and summarize risks.")
        .closest("button"),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByText("Frontend reviewer").closest("button")!);

    expect(screen.getByRole("link", { name: /세션 열기/ })).toHaveAttribute(
      "href",
      "/s/5f8bc275-283f-4218-8ccc-f6593d69e0cc",
    );
    expect(
      screen.getByText("Review the changed UI files and summarize risks."),
    ).not.toHaveClass("line-clamp-3");
    expect(screen.queryByText(/Agent response/)).toBeNull();
    expect(screen.queryByText("검수 완료: 문제 없음")).toBeNull();
    expect(
      screen.queryByText("mcp__agent-worker__agent_session_run_once"),
    ).toBeNull();
  });

  it("falls back to a stable human character for an unknown character id", () => {
    const message = agentWorkerMessage();
    message.content[0].toolUse!.result =
      message.content[0].toolUse!.result!.replace(
        '"🔎"',
        '"character:not-in-catalog"',
      );

    render(<MessageBubble message={message} />);

    const avatar = screen.getByAltText("Frontend reviewer");
    expect(avatar).toHaveAttribute(
      "src",
      expect.stringMatching(/^\/agent-characters\/korean-diverse-\d+\.webp$/),
    );
    expect(screen.queryByText("✦")).toBeNull();
    expect(screen.queryByText("character:not-in-catalog")).toBeNull();
  });

  it("keeps the launch card in running state while the backing Agent Session streams", () => {
    const message = agentWorkerMessage();
    useSessionStore.setState({
      streamingSessions: new Set(["5f8bc275-283f-4218-8ccc-f6593d69e0cc"]),
    });

    render(<MessageBubble message={message} />);

    expect(screen.getAllByText(/진행 중/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("작업 중")).toBeInTheDocument();
    expect(screen.queryByLabelText("답변 완료")).toBeNull();
  });

  it("renders structured agent_run summary and hides internal agent-report steering prompt", () => {
    const message: ChatMessage = {
      id: "agent-1",
      role: "user",
      timestamp: Date.now(),
      username: "QA steward",
      metadata: {
        sourceType: "agent_wake",
        agentWake: {
          fromName: "QA steward",
          mode: "wake",
          runId: "run-123456789",
        },
      },
      content: [
        {
          type: "agent_run",
          workerName: "QA steward",
          mode: "wake",
          status: "completed",
          runId: "run-123456789",
          summary: "검수 완료: 문제 없음",
          detailArtifacts:
            "- ~/workspace/projects/tower/reports/qa.md — 상세 검수 결과",
          detailArtifactPaths: ["~/workspace/projects/tower/reports/raw-qa.md"],
          detailArtifactSummary: "원문 로그와 비교표",
          readIfNeeded: "- qa.md §2 — 실패 원인 확인 시",
          retrievalHint: "persistent_agent_status에서 detailArtifactPaths 확인",
          suggestedNext: "배포 전 smoke test",
        } as any,
        {
          type: "text",
          text: "<agent-report>\nSource: QA steward\nInternal steering command\n</agent-report>",
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("QA steward")).toBeInTheDocument();
    expect(screen.getByText("검수 완료: 문제 없음")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "답변 펼치기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "답변 펼치기" }));
    expect(screen.getByRole("button", { name: "답변 접기" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("관련 파일")).toBeInTheDocument();
    expect(screen.getByText("필요할 때 확인")).toBeInTheDocument();
    expect(screen.getByText("찾는 방법")).toBeInTheDocument();
    expect(screen.getByText("다음으로 할 수 있는 일")).toBeInTheDocument();
    expect(screen.queryByText("Detail artifacts")).toBeNull();
    expect(screen.getByText(/상세 검수 결과/)).toBeInTheDocument();
    expect(
      screen.getByText("~/workspace/projects/tower/reports/raw-qa.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("persistent_agent_status에서 detailArtifactPaths 확인"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Internal steering command/)).toBeNull();
    expect(screen.queryByText(/<agent-report>/)).toBeNull();
  });

  it("hides assistant-role compact agent_report messages because launch cards own the lifecycle", () => {
    const message: ChatMessage = {
      id: "agent-report-1",
      role: "assistant",
      timestamp: Date.now(),
      metadata: {
        sourceType: "agent_report",
        agentReport: {
          fromName: "Research worker",
          mode: "inject",
          runId: "run-abcdef123456",
        },
      },
      content: [
        {
          type: "agent_run",
          workerName: "Research worker",
          mode: "inject",
          status: "completed",
          runId: "run-abcdef123456",
          backingSessionId: "session-abcdef123456",
          parentSessionId: "parent-abcdef123456",
          parentSessionName: "Parent Investigation Session",
          summary: "조사 완료: 핵심 근거 3개 확인",
          detailArtifacts:
            "- ~/workspace/projects/tower/research/deep.md — 긴 원문",
          readIfNeeded: "- deep.md §4 — 결론 충돌 시",
        } as any,
        {
          type: "text",
          text: "<agent-report>\nInternal prompt\n</agent-report>",
        },
      ],
    };

    render(<MessageBubble message={message} />);

    expect(screen.queryByText("Research worker")).toBeNull();
    expect(screen.queryByText("조사 완료: 핵심 근거 3개 확인")).toBeNull();
    expect(screen.queryByText(/Internal prompt/)).toBeNull();
  });
});

describe("MessageBubble — engine switch marker", () => {
  it("renders a divider chip (not a user bubble) when metadata.engineSwitch is present", () => {
    const message: ChatMessage = {
      id: "switch-1",
      role: "user", // backend stores marker as role='user' — UI must NOT render it as the user's words
      timestamp: Date.now(),
      content: [{ type: "text", text: "🔀 엔진 전환: claude → pi" }],
      metadata: {
        engineSwitch: {
          from: "claude",
          to: "pi",
          atTurn: 7,
          at: "2026-05-19T10:00:00Z",
        },
      },
    };

    render(<MessageBubble message={message} />);

    // Marker is detectable via data-testid + both engine labels are visible.
    const marker = screen.getByTestId("engine-switch-marker");
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveTextContent("Claude");
    expect(marker).toHaveTextContent("Pi");

    // CRITICAL: the raw marker text ("🔀 엔진 전환: ...") must NOT leak through
    // as a user bubble. The chip only shows engine labels, not the raw string.
    expect(screen.queryByText("🔀 엔진 전환: claude → pi")).toBeNull();
  });

  it("falls through to normal rendering when metadata is absent (defensive)", () => {
    const message: ChatMessage = {
      id: "plain-1",
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: "hello" }],
      // no metadata.engineSwitch
    };
    render(<MessageBubble message={message} />);
    expect(screen.queryByTestId("engine-switch-marker")).toBeNull();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
