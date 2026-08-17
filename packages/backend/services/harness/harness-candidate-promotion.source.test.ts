import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const lifecycle = fs.readFileSync(
  path.resolve(import.meta.dirname, "harness-lifecycle.ts"),
  "utf8",
);
const binding = fs.readFileSync(
  path.resolve(import.meta.dirname, "agent-harness-bindings.ts"),
  "utf8",
);
const api = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../routes/harness-api.ts"),
  "utf8",
);
describe("Harness candidate promotion contract", () => {
  it("publishes immutable candidates without moving current_version", () => {
    expect(lifecycle).toContain("'published','candidate'");
    expect(lifecycle).toContain("status='candidate'");
    const publish = lifecycle.slice(
      lifecycle.indexOf("export async function publishHarnessDraft"),
      lifecycle.indexOf("/** Promote an evaluated"),
    );
    expect(publish).not.toContain("UPDATE harnesses SET current_version");
  });
  it("requires a passing durable eval decision before promotion", () => {
    expect(lifecycle).toContain(
      "Passing Harness eval promotion decision required",
    );
    expect(lifecycle).toContain("promotion_status='promoted'");
    expect(lifecycle).toContain("promotion_decision_id=$4");
  });
  it("binds only the promoted current version", () => {
    expect(binding).toContain("h.current_version=v.version");
    expect(binding).toContain("v.promotion_status='promoted'");
  });
  it("exposes separate eval comparison and promote commands", () => {
    expect(api).toContain("/eval-comparisons");
    expect(api).toContain("/versions/:version/promote");
    expect(api).toContain("Operator access required");
  });
});
