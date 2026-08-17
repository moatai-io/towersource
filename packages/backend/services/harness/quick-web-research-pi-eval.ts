/**
 * Owns: privileged synthetic Pi turns for quick-web-research behavioral evaluation.
 * Public API: createQuickWebResearchPiEvalInvoker.
 */
import path from "node:path";
import { getEngine } from "../../engines/index.js";
import type {
  EngineCallbacks,
  TowerContentBlock,
} from "../../engines/types.js";
import {
  createSession,
  permanentlyDeleteSession,
} from "../session/session-manager.js";
import type { HarnessEvalTurnInvoker } from "./harness-eval-adapters.js";
import type { HarnessEvalObservation } from "./harness-eval-runner.js";
import type { HarnessEvalCase } from "./harness-eval-pack.js";
import { resolveHarnessCandidateReference } from "./harness-store.js";

function fixtureFor(
  testCase: HarnessEvalCase,
): Partial<Record<"web.fetch" | "web.search", string>> | undefined {
  const failure = testCase.setup?.simulatedFailure;
  if (!failure) return undefined;
  if (failure.startsWith("web.fetch")) return { "web.fetch": failure };
  if (failure.startsWith("web.search")) return { "web.search": failure };
  throw new Error(`Unsupported Harness eval fixture: ${failure}`);
}

function textFrom(blocks: TowerContentBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<TowerContentBlock, { type: "text" }> =>
        b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Create a private, exact-tuple Pi eval invoker. Every run gets an isolated Session. */
export async function createQuickWebResearchPiEvalInvoker(input: {
  harnessId: string;
  harnessVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  projectId: string;
  projectRoot: string;
  userId: number;
  username?: string;
  userRole: "admin" | "operator";
  model?: string;
}): Promise<HarnessEvalTurnInvoker> {
  const candidate = await resolveHarnessCandidateReference({
    harnessId: input.harnessId,
    harnessVersion: input.harnessVersion,
    runtimeProfileId: input.runtimeProfileId,
    runtimeProfileVersion: input.runtimeProfileVersion,
    engine: "pi",
    model: input.model,
  });
  const model = input.model || candidate.defaultModel;
  if (!model) throw new Error("Harness eval candidate requires a model");
  return {
    invoke: async ({
      testCase,
      runIndex,
      promptBundleHash,
    }): Promise<HarnessEvalObservation> => {
      if (promptBundleHash !== candidate.prompt.bundleHash)
        throw new Error(
          "Harness eval prompt bundle hash does not match candidate",
        );
      const meta = await createSession(
        `[eval] ${input.harnessId}@${input.harnessVersion} ${testCase.id} #${runIndex}`,
        input.projectRoot,
        input.userId,
        input.projectId,
        "pi",
        null,
        null,
        null,
        "temp",
        model,
        {
          visibility: "private",
          harness: {
            id: input.harnessId,
            version: input.harnessVersion,
            runtimeProfileId: input.runtimeProfileId,
            runtimeProfileVersion: input.runtimeProfileVersion,
          },
        },
      );
      const sessionId = meta.id;
      const engine = await getEngine("pi");
      const usedCapabilities: string[] = [];
      const assistantTexts: string[] = [];
      let actualModel = model;
      const callbacks: EngineCallbacks = {
        askUser: async () => {
          throw new Error("Harness eval runtime cannot ask the user");
        },
        claimSessionId: () => {},
        saveMessage: () => {},
        updateMessageContent: () => {},
        attachToolResult: () => {},
        updateMessageMetrics: () => {},
      };
      try {
        for await (const event of engine.run(
          sessionId,
          testCase.userPrompt,
          {
            cwd: path.resolve(input.projectRoot),
            projectId: input.projectId,
            userId: input.userId,
            username: input.username,
            userRole: input.userRole,
            accessiblePaths: [],
            denyImplicitBash: true,
            channelSafeToolsOnly: true,
            harnessId: input.harnessId,
            harnessVersion: input.harnessVersion,
            runtimeProfileId: input.runtimeProfileId,
            runtimeProfileVersion: input.runtimeProfileVersion,
            model,
            sessionProjectRoot: input.projectRoot,
            harnessEvalToolFixtures: fixtureFor(testCase),
          },
          callbacks,
        )) {
          if (event.type === "assistant") {
            const text = textFrom(event.content);
            if (text) assistantTexts.push(text);
            for (const block of event.content)
              if (block.type === "tool_use") {
                if (block.name === "WebFetch")
                  usedCapabilities.push("web.fetch");
                if (block.name === "WebSearch")
                  usedCapabilities.push("web.search");
              }
          }
          if (event.type === "engine_error") throw new Error(event.message);
          if (event.type === "engine_done" && event.model)
            actualModel = event.model;
        }
        const finalText = assistantTexts.at(-1) || "";
        if (!finalText)
          throw new Error("Harness eval runtime returned no assistant text");
        return {
          text: finalText,
          usedCapabilities,
          model: actualModel,
          metadata: {
            sessionId,
            caseId: testCase.id,
            runIndex,
            promptBundleHash,
            synthetic: true,
            fixture: fixtureFor(testCase) ?? null,
          },
        };
      } finally {
        engine.dispose(sessionId);
        await permanentlyDeleteSession(sessionId);
      }
    },
  };
}
