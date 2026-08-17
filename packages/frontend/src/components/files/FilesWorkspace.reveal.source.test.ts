import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const workspaceSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
const homeSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./ProjectHome.tsx"),
  "utf8",
);

describe("AI teammate file reveal", () => {
  it("opens the teammate file tab when a scoped reveal intent arrives", () => {
    expect(homeSource).toContain("tower-reveal-file-in-agent-home");
    expect(homeSource).toContain("setHomeTab('files')");
    expect(homeSource).toContain("revealPath={revealFilePath}");
  });

  it("loads only the target ancestry and highlights the matching row", () => {
    expect(workspaceSource).toContain("/api/files/reveal?");
    expect(workspaceSource).toContain("setExpandedPaths(new Set(ancestors))");
    expect(workspaceSource).toContain("data-files-workspace-path={entry.path}");
    expect(workspaceSource).toContain("tower-sidebar-reveal-highlight-file");
    expect(workspaceSource).not.toContain("bumpRefreshTrigger");
  });
});
