import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./ProjectHome.tsx"),
  "utf8",
);
describe("Project Home integrated header", () => {
  it("keeps identity and Home/Files tabs in one opaque sticky header", () => {
    expect(source).toContain(
      '<header className="pointer-events-auto sticky top-0 z-30',
    );
    expect(source).toContain("bg-surface-950");
    expect(source).toContain("aria-label={t('projectHome.navigationLabel')}");
    expect(source).not.toContain("sticky top-[53px]");
    expect(source).not.toContain("backdrop-blur-xl");
  });
  it("keeps mobile navigation above content with full-size touch targets", () => {
    expect(source).toContain("pointer-events-auto min-h-11 touch-manipulation");
    expect(source).toContain(
      "flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap",
    );
    expect(source).toContain("relative z-10 order-3 flex w-full");
    expect(source).toContain("sm:order-none sm:w-auto");
    expect(source).toContain("hidden max-w-[35%]");
  });
  it("uses theme-safe inactive tabs and one compact file viewport offset", () => {
    expect(source).toContain(
      "'text-surface-400 hover:bg-surface-800 hover:text-surface-100'",
    );
    expect(source).toContain("h-[calc(100vh-58px)]");
    expect(source).not.toContain("h-[calc(100vh-106px)]");
  });
  it("honors sidebar Home and Files destinations through shared navigation state", () => {
    expect(source).toContain("getAgentWorkspaceLocation");
    expect(source).toContain("requestedLocation === 'files'");
    expect(source).toContain(
      "rememberAgentWorkspaceLocation(project.id, 'files')",
    );
    expect(source).toContain(
      "rememberAgentWorkspaceLocation(project.id, 'home')",
    );
  });
});
