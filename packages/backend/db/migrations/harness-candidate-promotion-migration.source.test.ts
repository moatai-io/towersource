import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const migration = fs.readFileSync(
  path.resolve(import.meta.dirname, "133_harness_candidate_promotion.sql"),
  "utf8",
);
describe("Harness candidate promotion migration", () => {
  it("keeps versions immutable while separating promotion state", () => {
    expect(migration).toContain("promotion_status");
    expect(migration).toContain("'candidate','promoted','rejected'");
    expect(migration).toContain("promotion_decision_id");
  });
  it("guards current_version with a deferred promoted-version constraint", () => {
    expect(migration).toContain("harness_current_version_requires_promotion");
    expect(migration).toContain("v.promotion_status='promoted'");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
  });
});
