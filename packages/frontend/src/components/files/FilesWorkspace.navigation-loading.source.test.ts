import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);

describe("FilesWorkspace folder navigation loading", () => {
  it("keeps the current folder list visible while navigating inside one project", () => {
    expect(source).toContain("loadedProjectIdRef");
    expect(source).toContain(
      "replaceRootEntries && loadedProjectIdRef.current !== selectedProjectId",
    );
    expect(source).toContain("if (showBlockingLoader) setLoading(true)");
    expect(source).toContain("if (showBlockingLoader) setLoading(false)");
  });

  it("still uses a blocking loader for the first directory load of another project", () => {
    expect(source).toContain("loadedProjectIdRef.current = selectedProjectId");
    expect(source).toContain("[libraryView, selectedProjectId, showHidden]");
  });
});
