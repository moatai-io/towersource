import { describe, expect, it } from "vitest";
import {
  getAgentCardTitle,
  getAgentCardType,
  getAgentPromptPreview,
  isAgentTool,
  parseAgentWorkerResult,
} from "./agent-card-model";

describe("agent-card-model", () => {
  it("recognizes persistent agent-worker tools", () => {
    expect(isAgentTool("mcp__agent-worker__persistent_agent_create")).toBe(
      true,
    );
    expect(isAgentTool("functions.persistent_agent_send")).toBe(true);
    expect(isAgentTool("bash")).toBe(false);
  });

  it("derives display fields for persistent agent create calls", () => {
    const input = {
      name: "QA worker",
      role: "Review",
      instruction: "검수하세요",
    };
    expect(
      getAgentCardTitle("mcp__agent-worker__persistent_agent_create", input),
    ).toBe("QA worker");
    expect(
      getAgentCardType("mcp__agent-worker__persistent_agent_create", input),
    ).toBe("create");
    expect(
      getAgentPromptPreview(
        "mcp__agent-worker__persistent_agent_create",
        input,
      ),
    ).toBe("검수하세요");
  });

  it("recognizes spawn Session tools and exposes the sent prompt", () => {
    const input = {
      name: "송부 메시지 확인",
      prompt: "이 문장이 접힌 카드에도 보여야 합니다.",
    };

    expect(isAgentTool("mcp__tower-spawn__spawn_session")).toBe(true);
    expect(getAgentCardTitle("mcp__tower-spawn__spawn_session", input)).toBe(
      "송부 메시지 확인",
    );
    expect(
      getAgentPromptPreview("mcp__tower-spawn__spawn_session", input),
    ).toBe("이 문장이 접힌 카드에도 보여야 합니다.");
  });

  it("parses the backing Session id from a spawn result", () => {
    expect(
      parseAgentWorkerResult(
        'Spawned session "송부 메시지 확인" (id=527bdde4-8ae2-4a1d-a7fe-c75ec1bf8210, spawnId=8f17a914-89fb-4e57-9173-66e0700e60a0).',
        { name: "송부 메시지 확인" },
      )?.backingSessionId,
    ).toBe("527bdde4-8ae2-4a1d-a7fe-c75ec1bf8210");
  });

  it("parses worker/session/run ids and identity snapshot from tool result text", () => {
    const meta = parseAgentWorkerResult(
      [
        'Created subagent "QA worker".',
        "- workerId: 37bbac76-09ff-4f62-a383-7c61e2c0ebf3",
        "- backingSessionId: 5f8bc275-283f-4218-8ccc-f6593d69e0cc",
        "- initialRunId: 5cd428c6-936a-43b6-80a6-40f8122244cf",
        '- agentName: "QA worker"',
        '- agentRole: "독립 품질 검수"',
        '- agentFace: "character:core-engineer"',
        '- agentTagline: "회귀를 먼저 찾습니다"',
      ].join("\n"),
    );

    expect(meta).toEqual({
      workerId: "37bbac76-09ff-4f62-a383-7c61e2c0ebf3",
      backingSessionId: "5f8bc275-283f-4218-8ccc-f6593d69e0cc",
      runId: "5cd428c6-936a-43b6-80a6-40f8122244cf",
      mode: "",
      name: "QA worker",
      role: "독립 품질 검수",
      face: "character:core-engineer",
      tagline: "회귀를 먼저 찾습니다",
    });
  });
});
