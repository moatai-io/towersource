import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve("packages/frontend/src/components/files/ProjectHome.tsx"),
  "utf8",
);

describe("Primary Agent skill settings", () => {
  it("edits disabled skills inside teammate settings and persists them with the profile", () => {
    expect(source).toContain("disabledSkills: [] as string[]");
    expect(source).toContain("project?.agent?.toolPolicy?.disabledSkills");
    expect(source).toContain("이 팀원이 사용할 Skill");
    expect(source).toContain("이 AI 팀원의 새 대화부터 제외됩니다.");
    expect(source).toContain("body: JSON.stringify(teammateDraft)");
  });
});
