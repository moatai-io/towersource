import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const service = fs.readFileSync(
  path.resolve(import.meta.dirname, "./session-conversation-service.ts"),
  "utf8",
);
const spawnServer = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../mcp/spawn-server.ts"),
  "utf8",
);
const agentWorkers = fs.readFileSync(
  path.resolve(import.meta.dirname, "../agent-workers.ts"),
  "utf8",
);
const sessionItem = fs.readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../../frontend/src/components/sessions/SessionItem.tsx",
  ),
  "utf8",
);
const toolbar = fs.readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../../frontend/src/features/navigation-sidebar/sessions/SidebarSessionsToolbar.tsx",
  ),
  "utf8",
);
const agentCards = fs.readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../../frontend/src/features/agent-card/AgentCards.tsx",
  ),
  "utf8",
);

describe("unified addressable Session conversation contract", () => {
  it("offers one create-or-continue boundary over existing compatible RPC paths", () => {
    expect(service).toContain("createSessionConversation");
    expect(service).toContain("sendSessionConversationMessage");
    expect(service).toContain("return spawnChildSession({");
    expect(service).toContain("return sendToSession({");
    expect(spawnServer).toContain("createSessionConversation({");
    expect(spawnServer).not.toContain("spawnChildSession({");
  });

  it("adapts registered Agent identity creation and follow-up onto the same Session boundary", () => {
    expect(agentWorkers).toContain("createSessionConversation({");
    expect(agentWorkers).toContain("sendSessionConversationMessage({");
    expect(agentWorkers).not.toContain("spawnChildSession({");
    expect(agentWorkers).not.toContain("sendToSession({");
    expect(service).toContain("agentReport: input.agentReport");
    expect(service).toContain("effort: input.effort");
  });

  it("does not expose subagent as a permanent Session badge or filter label", () => {
    expect(sessionItem).not.toContain("isPureAgentSession(session)");
    expect(sessionItem).not.toContain("Subagent session");
    expect(toolbar).toContain("Agent 대화");
    expect(toolbar).not.toContain("{t('subagents')}");
  });

  it("keeps launch cards to activity while participant messages own the response", () => {
    expect(agentCards).not.toContain("agentResponse ? <AgentResultSection");
    expect(agentCards).not.toContain("function AgentResultSection");
    expect(agentCards).toContain("송부 내용 펼치기");
    expect(agentCards).toContain("송부 내용 접기");
  });
});
