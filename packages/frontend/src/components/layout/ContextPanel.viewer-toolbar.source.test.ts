import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contextPanelSource = readFileSync(
  new URL("./ContextPanel.tsx", import.meta.url),
  "utf8",
);
const ttsSource = readFileSync(
  new URL("../files/MarkdownTtsControls.tsx", import.meta.url),
  "utf8",
);

describe("ContextPanel viewer toolbar source contracts", () => {
  it("wraps the mobile Viewer file header without clipping its action menu", () => {
    expect(contextPanelSource).toContain(
      "relative z-20 flex shrink-0 flex-wrap items-center",
    );
    expect(contextPanelSource).toContain("overflow-visible whitespace-nowrap");
    expect(contextPanelSource).toContain("sm:flex-nowrap sm:overflow-x-auto");
    expect(contextPanelSource).toContain("import { FileActionsMenu }");
    expect(contextPanelSource).toContain("<FileActionsMenu>");
    expect(contextPanelSource).toContain("{t('shareLink')}");
    expect(contextPanelSource).toContain("scrollbar-none");
  });

  it("keeps TTS inside the shared overflow menu instead of hiding it on mobile", () => {
    expect(ttsSource).toContain("{paused ? '▶' : speaking ? '⏸' : '▶'}");
    expect(contextPanelSource).toContain("<MarkdownTtsControls");
    expect(contextPanelSource).toContain("content={openFile.content}");
    expect(contextPanelSource).toContain('className="w-full justify-start"');
    expect(contextPanelSource).toContain("openFile.language === 'markdown' && (");
    expect(contextPanelSource).not.toContain("openFile.language === 'markdown' && !isMobileDocument");
    expect(contextPanelSource).not.toContain(
      'className="hidden sm:inline-flex"',
    );
    expect(contextPanelSource).toContain("<FileActionsMenu>");
  });

  it("uses a narrow mobile view-mode selector", () => {
    expect(contextPanelSource).toContain("h-8 w-[4.75rem] shrink-0");
    expect(contextPanelSource).toContain("px-1.5 text-xs");
  });

  it("styles the save action consistently with the surrounding toolbar buttons", () => {
    expect(contextPanelSource).toContain(
      "rounded-md border border-primary-500/30 bg-primary-600 px-2.5 py-1 text-sm font-semibold text-white",
    );
    expect(contextPanelSource).not.toContain(
      "text-sm px-2 py-0.5 bg-primary-600 hover:bg-primary-700 rounded",
    );
  });
});
