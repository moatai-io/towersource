import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const runtime=fs.readFileSync(path.resolve(import.meta.dirname,"quick-web-research-pi-eval.ts"),"utf8");
const assembly=fs.readFileSync(path.resolve(import.meta.dirname,"../../engines/pi/tool-assembly.ts"),"utf8");
const tools=fs.readFileSync(path.resolve(import.meta.dirname,"../../engines/pi-harness-capability-tools.ts"),"utf8");
describe("quick-web-research privileged Pi eval runtime",()=>{
  it("creates isolated private exact-tuple sessions and always disposes them",()=>{
    expect(runtime).toMatch(/visibility:\s*["']private["']/);
    expect(runtime).toMatch(/harnessVersion:\s*input\.harnessVersion/);
    expect(runtime).toMatch(/runtimeProfileVersion:\s*input\.runtimeProfileVersion/);
    expect(runtime).toContain("engine.dispose(sessionId)");expect(runtime).toContain("permanentlyDeleteSession(sessionId)");
  });
  it("denies filesystem authority and captures only declared web capabilities",()=>{
    expect(runtime).toMatch(/accessiblePaths:\s*\[\]/);expect(runtime).toMatch(/denyImplicitBash:\s*true/);expect(runtime).toMatch(/channelSafeToolsOnly:\s*true/);
    expect(runtime).toMatch(/usedCapabilities\.push\(["']web\.fetch["']\)/);expect(runtime).toMatch(/usedCapabilities\.push\(["']web\.search["']\)/);
  });
  it("injects deterministic fixtures only through server-owned RunOpts",()=>{
    expect(runtime).toMatch(/harnessEvalToolFixtures:\s*fixtureFor\(testCase\)/);expect(assembly).toContain("opts.harnessEvalToolFixtures");expect(tools).toMatch(/behavioralEvalFixture:\s*true/);
  });
});
