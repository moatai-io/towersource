import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./FileViewerPage.tsx", import.meta.url),
  "utf8",
);

describe("FileViewerPage mobile toolbar source contracts", () => {
  it("keeps mobile file actions visible above the document surface", () => {
    expect(source).toContain(
      "relative z-20 flex min-h-11 shrink-0 flex-wrap items-center",
    );
    expect(source).toContain("overflow-visible border-b border-surface-700");
    expect(source).toContain("sm:h-11 sm:flex-nowrap");
    expect(source).toContain("import { FileActionsMenu }");
    expect(source).toContain("<FileActionsMenu>");
    expect(source).toContain("t('shareLink')");
    expect(source).toContain("<MarkdownTtsControls");
    expect(source).toContain("content={content}");
    expect(source).toContain('className="w-full justify-start"');
    expect(source).not.toContain('className="hidden sm:inline-flex"');
    expect(source).toContain("<FileActionsMenu>");
    expect(source).toContain("h-8 w-[4.75rem] shrink-0");
  });
});
