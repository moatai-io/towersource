import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./ProjectHome.tsx"),
  "utf8",
);

describe("AI teammate settings modal layout", () => {
  it("keeps the action footer visible while long settings content scrolls", () => {
    expect(source).toContain("max-h-[calc(100dvh-1.5rem)]");
    expect(source).toContain("sm:max-h-[86dvh]");
    expect(source).toContain("min-h-0 flex-1 space-y-3 overflow-y-auto");
    expect(source).toContain("flex shrink-0 justify-end gap-2 border-t");
  });

  it("separates profile selection from the optional profile generator", () => {
    expect(source).toContain("프로필 선택");
    expect(source).toContain("기본 프로필 중 하나를 선택하세요.");
    expect(source).toContain("원하는 프로필이 없나요?");
    expect(source).toContain("설명만 입력해 새로 생성해봐요.");
    expect(source).toContain("characterGeneratorOpen?'접기':'새 프로필 생성'");
    expect(source).toContain("aria-expanded={characterGeneratorOpen}");
    expect(source).not.toContain("새 얼굴 직접 생성");
    expect(source).not.toContain("우리 API 키로 생성");
  });

  it("uses the canonical generated character endpoint from teammate settings", () => {
    expect(source).toContain("fetch('/api/agent-characters/generate'");
    expect(source).toContain("projectId: project.id");
    expect(source).toContain(
      "Credential Vault의 OpenAI Image 연결을 사용합니다.",
    );
    expect(source).not.toContain("/agent-character/generate`");
  });

  it("updates the project store without reloading the whole page after save", () => {
    expect(source).toContain(
      "useProjectStore.getState().updateProject(updatedProject.id, updatedProject)",
    );
    expect(source).toContain("toastSuccess('팀원 설정을 저장했습니다.')");
    expect(source).not.toContain("window.location.reload()");
  });
});
