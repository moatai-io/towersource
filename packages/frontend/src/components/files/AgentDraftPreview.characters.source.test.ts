import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./AgentDraftPreview.tsx"),
  "utf8",
);

describe("AI teammate character picker", () => {
  it("offers the curated prototype catalog without fake scale", () => {
    expect(source).toContain("AGENT_CHARACTERS.map");
    expect(source).toContain("t('agentCreation.chooseFace')");
    expect(source).not.toContain("character.ageBand");
    expect(source).not.toContain("나머지 30개 캐릭터 보기");
  });

  it("persists selection through the existing face field", () => {
    expect(source).toContain("setFace(`character:${character.id}`)");
    expect(source).toContain("characterFace(draft.face)");
  });

  it("provides an explicit custom generation request", () => {
    expect(source).toContain("t('agentCreation.customCharacterQuestion')");
    expect(source).toContain("fetch('/api/agent-characters/generate'");
    expect(source).toContain("const sourceProjectId = draft?.sourceProjectId || sessions.find");
    expect(source).toContain("projectId: sourceProjectId");
    expect(source).toContain("t('agentCreation.generateNewFace')");
    expect(source).toContain("agentFaceImageUrl(draft?.face)");
  });

  it("shows character choices immediately and creates with one plain action", () => {
    expect(source).not.toContain("customCharacterOpen");
    expect(source).not.toContain("얼굴 바꾸기");
    expect(source).toContain("t('agentCreation.create')");
    expect(source).not.toContain("이 동료를 팀에 합류시킬까요?");
    expect(source).not.toContain("합류 내용 확인하기");
    expect(source).not.toContain("합류시키고 첫 대화 열기");
    expect(source).not.toContain("fetch(`/api/harnesses?projectId=");
  });
});
