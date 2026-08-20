import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
const s = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
describe("Project outline files", () => {
  it("locks embedded workspace to its project and uses one outline", () => {
    expect(s).toContain("initialProjectId");
    expect(s).toContain("embedded");
    expect(s).toContain("outlineRows.map");
    expect(s).not.toContain("격자");
  });
  it("sorts metadata columns and filters kinds", () => {
    for (const t of [
      'setFileSortMode("name")',
      'setFileSortMode("type")',
      'setFileSortMode("modified")',
      "kindFilter",
      "workspace.size",
      "workspace.type",
      "workspace.modifiedDate",
    ])
      expect(s).toContain(t);
  });
  it("expands folders without replacing root entries", () => {
    for (const t of [
      "toggleFolder",
      "await loadDirectory(entry.path, false)",
      "if (replaceRootEntries) setEntries(nextEntries)",
      "expandedPaths.has(entry.path)",
    ])
      expect(s).toContain(t);
  });
  it("routes file mutations through one partial-refresh contract", () => {
    const mutationBlock = s.slice(
      s.indexOf("const refreshDirectories = useCallback"),
      s.indexOf("const uploadItems = async"),
    );
    expect(mutationBlock).not.toContain("setColumnEntries({})");
    expect(mutationBlock).toContain("const runFileMutation = useCallback");
    expect(mutationBlock).toContain("new Set([currentPath, ...changedDirectories]");
    expect(mutationBlock).toContain("await refreshDirectories(affectedDirectories)");
    expect(mutationBlock).toContain("pathReplacements = []");
    expect(mutationBlock).toContain("path.startsWith(`${removedPath}/`)");
    expect((s.match(/await runFileMutation\(\{/g) || []).length).toBeGreaterThanOrEqual(7);
  });
  it("supports purpose views and optional missing folders", () => {
    for (const t of [
      "published",
      "sharedFiles",
      "projectSkills",
      "sharedSkills",
      "missingOptionalLibrary",
      'libraryView !== "all"',
    ])
      expect(s).toContain(t);
  });
  it("keeps theme-safe file controls", () => {
    expect(s).toContain("text-primary-700 dark:text-primary-200");
    expect(s).toContain("text-surface-700 dark:text-surface-300");
  });
});
