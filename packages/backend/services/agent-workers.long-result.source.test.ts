import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "./agent-workers.ts"),
  "utf-8",
);

describe("agent-workers long-result artifact contract", () => {
  it("settles runs with structured artifact paths extracted from backing session reports", () => {
    expect(SRC).toContain("function extractArtifactPathsFromText");
    expect(SRC).toContain(`extractReportSection(text, "DETAIL_ARTIFACTS")`);
    expect(SRC).toContain("artifact_paths = CASE");
    expect(SRC).toMatch(
      /completeRun\(runId, resultSummary, "completed", artifactPaths\)/,
    );
  });

  it("surfaces artifact paths in persistent_agent_status output", () => {
    expect(SRC).toContain("Detail artifact paths:");
    expect(SRC).toContain("parseJsonArray(latest?.artifact_paths)");
    expect(SRC).toContain("formatArtifactPath");
  });

  it("attaches a retrieval hint to agent report provenance", () => {
    expect(SRC).toContain("retrievalHint:");
    expect(SRC).toContain("use detailArtifactPaths when present");
  });

  it("backfills a parent agent report when run settlement recovers an existing backing-session response", () => {
    expect(SRC).toContain("ensureAgentRunReportDelivered");
    expect(SRC).toMatch(
      /await completeRun\(runId, resultSummary, "completed", artifactPaths\);[\s\S]*await ensureAgentRunReportDelivered\(\{/,
    );
    expect(SRC).toContain("parentSessionId: worker.parent_session_id");
    expect(SRC).toContain("parentUserId: worker.owner_user_id");
    expect(SRC).toContain("text: last.text");
    expect(SRC).toContain("backingSessionId: worker.backing_session_id");
  });

  it("normalizes persistent worker report rescue to wake-only", () => {
    expect(SRC).toContain('onComplete: input.onComplete || "wake"');
    expect(SRC).toContain('onComplete: "wake" as SendOnComplete');
    expect(SRC).toContain('Persistent worker communication is supervisor-driven');
  });

  it("periodically re-arms running worker run settlement after restart retry windows", () => {
    expect(SRC).toContain("export function startAgentRunSettlementRecovery");
    expect(SRC).toContain("recoverRunningAgentRunsOnStartup().catch");
    expect(SRC).toContain("setInterval");
    expect(SRC).toContain("60_000");
    expect(SRC).toContain("export function stopAgentRunSettlementRecovery");
  });
});
