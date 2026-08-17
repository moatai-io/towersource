import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const readSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./MarkdownReadSurface.tsx"),
  "utf8",
);
const previewSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./MarkdownPreviewSurface.tsx"),
  "utf8",
);
const workspaceSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FilesWorkspace.tsx"),
  "utf8",
);
const projectHomeSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./ProjectHome.tsx"),
  "utf8",
);
const fileViewerSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./FileViewerPage.tsx"),
  "utf8",
);
const contextPanelSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../layout/ContextPanel.tsx"),
  "utf8",
);

describe("Markdown preview loading boundaries", () => {
  it("keeps the read-only surface free of editing dependencies", () => {
    for (const dependency of [
      "useInlineEdit",
      "DiffPreview",
      "MarkdownDirectEditSurface",
      "CodeEditor",
      "MarkdownEditor",
    ]) {
      expect(readSource).not.toContain(dependency);
    }
  });

  it("loads Mermaid conditionally from the read surface", () => {
    expect(readSource).toContain("await import('../chat/MermaidBlock')");
    expect(readSource).toContain("recoverFromChunkLoadError()");
    expect(readSource).not.toContain("from '../chat/MermaidBlock'");
  });

  it("uses the small read-only surface for project instructions and normal previews", () => {
    expect(workspaceSource).toContain("MarkdownReadSurface");
    expect(workspaceSource).not.toContain("MarkdownPreviewSurface");
    expect(projectHomeSource).toContain("MarkdownReadSurface");
    expect(projectHomeSource).not.toContain("MarkdownPreviewSurface");
    expect(fileViewerSource).toContain("MarkdownReadSurface");
    expect(contextPanelSource).toContain("MarkdownReadSurface");
  });

  it("preserves editing integration in the full preview surface", () => {
    expect(previewSource).toContain("useInlineEdit");
    expect(previewSource).toContain("MarkdownDirectEditSurface");
    expect(previewSource).toContain("MarkdownReadSurface");
  });

  it("lazy-loads viewer editing and TTS dependencies", () => {
    for (const source of [fileViewerSource, contextPanelSource]) {
      expect(source).toMatch(/React\.lazy\(\(\) => import\([^)]*CodeEditor/);
      expect(source).toMatch(
        /React\.lazy\(\(\) => import\([^)]*MarkdownEditor/,
      );
      expect(source).toMatch(
        /React\.lazy\(\(\) => import\([^)]*MarkdownTtsControls/,
      );
      expect(source).toMatch(
        /React\.lazy\(\(\) => import\([^)]*MarkdownPreviewSurface/,
      );
      expect(source).not.toMatch(/^import \{ CodeEditor \}/m);
      expect(source).not.toMatch(/^import \{ MarkdownEditor \}/m);
      expect(source).not.toMatch(/^import \{ MarkdownTtsControls \}/m);
    }
  });
});
