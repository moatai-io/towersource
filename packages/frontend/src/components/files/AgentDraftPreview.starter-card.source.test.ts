import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./AgentDraftPreview.tsx"),
  "utf8",
);
const app = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../App.tsx"),
  "utf8",
);

describe("AI employee bootstrap card", () => {
  it("asks only for a face, name, and expected expertise before creation", () => {
    expect(source).toContain("t('agentCreation.newAiTeammate')");
    expect(source).toContain("t('agentCreation.chooseFace')");
    expect(source).not.toContain("얼굴 바꾸기");
    expect(source).toContain("t('agentCreation.name')");
    expect(source).toContain("t('agentCreation.expectedExpertise')");
    expect(source).toContain("t('agentCreation.create')");
    expect(source).toContain("startChat(session.id)");
    expect(source).not.toContain("합류시키고 첫 출근 열기");
    expect(source).not.toContain("첫 출근 대화 열기");
    for (const removedLabel of ["책임지는 결과", "첫 업무", "실행 환경"]) {
      expect(source).not.toContain(removedLabel);
    }
  });

  it("uses one create action, navigates immediately, and only shows recovery after navigation failure", () => {
    expect(source).not.toContain(
      "fetch('/api/primary-agent-commands/bootstrap-preview-intents'",
    );
    expect(source).toContain("fetch('/api/primary-agent-commands/bootstrap'");
    expect(source).not.toContain("reviewOpen");
    expect(source).not.toContain("bootstrapPreview");
    expect(source).toContain(
      "setRecovery({ projectName: project.name, sessionId: session.id })",
    );
    expect(source).toContain(
      "if (sessionStore.isMobile) sessionStore.finishMobileContextInChat()",
    );
    expect(source).toContain("t('agentCreation.reopenConversation')");
    expect(source).toContain("expectedExpertise: expertise");
    expect(source).toContain("draft?.sourceProjectId || sessions.find");
    expect(app).toContain("draft.sourceProjectId = sourceProject?.id");
    expect(source).not.toContain("fetch(`/api/harnesses?projectId=");
    expect(source).not.toContain("harnessBinding");
    expect(source).toContain("value={expertiseInput}");
    expect(source).toContain("expectedExpertise: event.target.value");
  });

  it("opens the minimal creator directly without starting a helper conversation", () => {
    expect(app).toContain("draft.sourceProjectId = sourceProject?.id");
    expect(app).toContain(
      "mobileHiring ? { split: 'right', name: t('newAiTeammate') } : { name: t('newAiTeammate') }",
    );
    expect(app).not.toContain("AI talent team seed project is unavailable");
    expect(app).not.toContain("createSessionInDb('AI 인재팀과 새 직원 찾기'");
    expect(app).not.toContain("agent-academy-greeting");
    expect(app).not.toContain("당신은 Tower의 “AI 인재팀”");
    expect(app).not.toContain("{ split: 'right', name: 'AI 직원 초안' }");
  });
});
