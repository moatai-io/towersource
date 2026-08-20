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
    expect(source).toContain("t('projectHome.selectProfile')");
    expect(source).toContain("t('projectHome.selectDefaultProfile')");
    expect(source).toContain("t('projectHome.noDesiredProfile')");
    expect(source).toContain("t('projectHome.generateProfileDescription')");
    expect(source).toContain("characterGeneratorOpen?t('projectHome.collapse'):t('projectHome.generateNewProfile')");
    expect(source).toContain("aria-expanded={characterGeneratorOpen}");
    expect(source).not.toContain("새 얼굴 직접 생성");
    expect(source).not.toContain("우리 API 키로 생성");
  });

  it("uses the canonical generated character endpoint from teammate settings", () => {
    expect(source).toContain("fetch('/api/agent-characters/generate'");
    expect(source).toContain("projectId: project.id");
    expect(source).toContain("t('projectHome.imageConnectionHint')");
    expect(source).not.toContain("/agent-character/generate`");
  });

  it("updates the project store without reloading the whole page after save", () => {
    expect(source).toContain(
      "useProjectStore.getState().updateProject(updatedProject.id, updatedProject)",
    );
    expect(source).toContain("toastSuccess(t('projectHome.teammateSaved'))");
    expect(source).not.toContain("window.location.reload()");
  });
});
