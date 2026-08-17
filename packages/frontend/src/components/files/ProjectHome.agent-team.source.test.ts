import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./ProjectHome.tsx"),
  "utf8",
);
const overview = fs.readFileSync(
  path.resolve(import.meta.dirname, "../agents/AgentHomeOverview.tsx"),
  "utf8",
);

describe("AI teammate home surface", () => {
  it("presents the teammate work home without legacy project-home sections", () => {
    expect(source).toContain("<AgentHomeOverview");
    expect(source).toContain('aria-label="AI 팀원 홈 보기"');
    for (const removed of [
      "AI Teammate Index",
      "Project Guidance",
      "주요 노트",
      '<section id="project-wiki"',
      "Project Tools",
      "Principle",
    ])
      expect(source).not.toContain(removed);
  });

  it("centers shared work, growth, usage, skills, and conversations without a separate Approval result surface", () => {
    for (const value of [
      "함께 고민한 업무",
      "성장",
      "최근 30일 활용",
      "Skill 역량",
      "최근 대화",
      "협업 멤버별 활용",
    ])
      expect(overview).toContain(value);
    expect(overview).not.toContain("최근 결과");
  });

  it("connects sessions, work, editing, and home projection", () => {
    for (const value of [
      "recentSessions={projectSessions.slice(0, 3)}",
      "workstreams={visibleWorkstreams}",
      "onOpenSession={openSession}",
      "onNewConversation={startNewConversation}",
      "onEditTeammate={editTeammate}",
      "activity={agentHome?.activity ?",
    ])
      expect(source).toContain(value);
  });

  it("keeps the work projection available through the home API without Approval deep links", () => {
    expect(source).toContain("/api/projects/${project.id}/agent-home");
    expect(overview).not.toContain("onOpenApproval");
    expect(source).not.toContain("new CustomEvent('tower-open-approval'");
  });
});
