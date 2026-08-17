import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const projectHome = fs.readFileSync(
  path.resolve(import.meta.dirname, "./ProjectHome.tsx"),
  "utf8",
);
const app = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../App.tsx"),
  "utf8",
);
const fileStore = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../stores/file-store.ts"),
  "utf8",
);

describe("single canonical AI teammate home route", () => {
  it("renders the project face through the shared avatar instead of exposing the face id", () => {
    expect(projectHome).toContain("<AgentIdentityAvatar project={project}");
    expect(projectHome).not.toContain("{project.agent?.face || '✨'}");
  });

  it("resolves Project Home only from the system tab refId", () => {
    expect(app).toContain(
      "activeSystemTabKind === 'projectFiles' && activeSystemTabRefId",
    );
    expect(app).not.toContain(
      "projects.find((p) => p.id === activeSessionProjectId)\n    || projects.find((p) => p.pinned",
    );
  });

  it("rejects legacy project home tabs that do not identify a project", () => {
    expect(fileStore).toContain(
      "t.kind === 'projectFiles' && typeof t.refId === 'string' && t.refId.length > 0",
    );
    expect(fileStore).toContain(
      "if (kind === 'projectFiles' && !refId) return s",
    );
  });
});
