import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Pi engine tests — session persistence, tool registration, abort.
 *
 * These are unit/integration tests that verify Pi engine behavior
 * without requiring a running server. Uses temp directories for isolation.
 */

// ── Helpers ──

const PI_ENGINE_PATH = path.resolve(import.meta.dirname, '../pi-engine.ts');
const PI_FAILURE_CLASSIFIER_PATH = path.resolve(import.meta.dirname, '../pi-failure-classifier.ts');
const PI_TOOL_ASSEMBLY_PATH = path.resolve(import.meta.dirname, '../pi/tool-assembly.ts');
const PI_SESSION_RESOURCES_PATH = path.resolve(import.meta.dirname, '../pi/session-resources.ts');
const PI_FINANCE_TOOLS_PATH = path.resolve(import.meta.dirname, '../pi-finance-tools.ts');
const PI_FINANCE_EXTRA_PATH = path.resolve(import.meta.dirname, '../pi-finance-tools-extra.ts');
const PI_RUNTIME_BOX_TOOLS_PATH = path.resolve(import.meta.dirname, '../pi-runtime-box-tools.ts');
const PI_PDF_AWARE_READ_TOOL_PATH = path.resolve(import.meta.dirname, '../pi-pdf-aware-read-tool.ts');
const PI_PDF_VIEW_TOOL_PATH = path.resolve(import.meta.dirname, '../pi-pdf-view-tool.ts');
const PI_PDF_EXPORT_TOOL_PATH = path.resolve(import.meta.dirname, '../pi-pdf-export-tool.ts');
const PI_CAD_VIEW_TOOL_PATH = path.resolve(import.meta.dirname, '../pi-cad-view-tool.ts');
const PI_PUBLISH_TOOL_PATH = path.resolve(import.meta.dirname, '../pi-publish-tool.ts');
const PI_TOOL_CATEGORIES_PATH = path.resolve(import.meta.dirname, '../pi-tool-categories.ts');
const PI_PROCESS_MAP_TOOL_PATH = path.resolve(import.meta.dirname, '../pi-process-map-tool.ts');
const MESSAGE_STORE_PATH = path.resolve(import.meta.dirname, '../../services/message-store.ts');
// Unified models.json (pi array) — see 2026-05-15 unified-model-registry refactor.
// Old engines/pi-models.json was removed; pi-engine now reads loadModelsFile().pi
// from the same source the frontend uses for model cards.
const MODELS_JSON_PATH = path.resolve(import.meta.dirname, '../../models.json');

function readSource(file: string): string {
  const source = fs.readFileSync(file, 'utf-8');
  if (file !== PI_ENGINE_PATH) return source;

  // pi-engine.ts is intentionally a thin orchestrator now; source-contract tests
  // assert the Pi engine behavior surface, which may live in focused modules under
  // engines/pi/ after strangler-style refactors.
  const piModuleDir = path.resolve(import.meta.dirname, '../pi');
  const moduleSources = fs.readdirSync(piModuleDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => fs.readFileSync(path.join(piModuleDir, name), 'utf-8'));
  return [source, ...moduleSources].join('\n\n');
}

// ── Tests ──

describe('Pi engine — source contracts', () => {
  it('drains aborted terminal events before engine_done instead of breaking the yield loop early', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).not.toContain('entry.abortRequested && eventQueue.length === 0');
    expect(src).toMatch(/while \(!done \|\| eventQueue\.length > 0\)[\s\S]*?await promptPromise[\s\S]*?type: 'engine_done'/);
    expect(src).toMatch(/if \(entry\.abortRequested\) \{[\s\S]*?emitTurnDone\('aborted'\)[\s\S]*?return;/);
  });

  it('pi-engine.ts exists and exports PiEngine', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/export class PiEngine implements Engine/);
  });

  it('uses file-based SessionManager (not inMemory)', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Should use SessionManager.create or SessionManager.open, not just inMemory
    expect(src).toMatch(/SessionManager\.create\(/);
    expect(src).toMatch(/SessionManager\.open\(/);
  });

  it('claims engineSessionId for DB persistence', () => {
    const src = readSource(PI_ENGINE_PATH);
    // claimSessionId should be called after session creation
    expect(src).toMatch(/callbacks\.claimSessionId/);
  });

  it('resumes from engineSessionId when available', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Should check opts.engineSessionId and open existing session
    expect(src).toMatch(/opts\.engineSessionId/);
    expect(src).toMatch(/Resuming session/);
  });

  it('engine_done includes engineSessionId', () => {
    const src = readSource(PI_ENGINE_PATH);
    // engine_done message should include session file path
    expect(src).toMatch(/engineSessionId.*piSessionFile|piSessionFile.*engineSessionId/s);
  });

  it('abort keeps session busy until prompt promise settles', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/entry\.abortRequested\s*=\s*true/);
    expect(src).toMatch(/keep isRunning=true until the prompt promise actually settles/i);
    expect(src).toMatch(/await promptPromise/);
  });

  it('stores session files in {cwd}/.pi/sessions/', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/\.pi.*sessions/);
  });

  it('buffers turn usage until the whole prompt finishes', () => {
    const src = readSource(PI_ENGINE_PATH);
    // message_end tracks iterations but does NOT emit turn_done
    expect(src).toMatch(/iterationCount\+\+/);
    expect(src).toMatch(/cumulativeInput/);
    // turn_done is emitted only in promptPromise.then()
    expect(src).toMatch(/promptWithFetchCorrelation\(prompt\)[\s\S]*?emitTurnDone\(/);
  });

  it('does not emit turn_done directly from message_end', () => {
    const src = readSource(PI_ENGINE_PATH);
    const messageEndBlock = src.match(/case 'message_end':[\s\S]*?break;\n        }/);
    expect(messageEndBlock?.[0]).toBeTruthy();
    expect(messageEndBlock?.[0]).not.toContain("type: 'turn_done'");
  });

  it('G2: includes context metrics in turn_done (same contract as Claude)', () => {
    const src = readSource(PI_ENGINE_PATH);
    // turn_done must include actual provider context for the user-facing footer.
    // Risk/transcript estimates stay separate for internal compaction/preflight
    // decisions so CTX does not overstate actual model usage.
    expect(src).toMatch(/const actualContextInputTokens = runCtx\.actualContextInputTokens\(\)/);
    expect(src).toMatch(/const riskContextEstimateTokens = runCtx\.riskContextEstimateTokens\(estimatedLiveContextInput\)/);
    expect(src).toMatch(/usage:\s*runCtx\.usageSummary\(\{/);
    expect(src).toMatch(/const userFacingStopReason = effectiveErrorStopReason \|\| \(state\.stopReason === 'toolUse' \? 'stop' : state\.stopReason\)/);
    expect(src).toMatch(/contextInputTokens/);
  });

  it('G2: tracks durationMs as wall-clock time', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/turnStartTime\s*=\s*Date\.now\(\)/);
    expect(src).toMatch(/Date\.now\(\)\s*-\s*turnStartTime/);
  });

  it('G3: fails session creation without replacing an unrestorable native session', () => {
    const src = readSource(PI_ENGINE_PATH);
    const managerSrc = readSource(path.resolve(import.meta.dirname, '../pi/session-manager.ts'));
    expect(managerSrc).toContain('Previous Pi conversation could not be restored');
    expect(managerSrc).not.toMatch(/Resume failed[\s\S]*SessionManager\.create/);
    expect(src).toMatch(/Pi session creation failed:/);
  });

  it('G3: does NOT clear session ID on resume failure (preserves recovery)', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Session ID should NEVER be cleared — clearing causes permanent context loss
    expect(src).not.toMatch(/claimSessionId\(''\)/);
  });

  it('syncs final assistant content from message_end payload', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/agentMessageToTowerBlocks/);
    expect(src).toMatch(/message_end[\s\S]*?accumulator\.replaceAll\(analysis\.assistantContent\.finalContent\)/);
    // We use `contentToSave` (fallback to accumulator when finalContent is empty)
    // to preserve tool-use blocks when GPT models emit an empty trailing message.
    expect(src).toMatch(/message_end[\s\S]*?queueAssistantDbUpdate\(msgId, contentToSave, true\)/);
    expect(src).toMatch(/message_end[\s\S]*?queueAssistantEvent\(contentToSave, true\)/);
  });

  it('does not persist empty assistant content from structural message_update events', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/if \(content\.length > 0\)[\s\S]*?callbacks\.saveMessage/);
    expect(src).toMatch(/if \(content\.length > 0\)[\s\S]*?queueAssistantEvent\(content/);
  });

  it('injects the active Tower session ID into Pi bash tool spawns', () => {
    const src = readSource(PI_TOOL_ASSEMBLY_PATH);
    expect(src).toMatch(/function createTowerSessionBashSpawnHook\(sessionId: string\)/);
    expect(src).toMatch(/createBashTool\(opts\.cwd,\s*\{[\s\S]*?spawnHook:\s*createTowerSessionBashSpawnHook\(sessionId\)/);
    expect(src).toMatch(/TOWER_SESSION_ID:\s*sessionId/);
  });
});

describe('Pi engine — model safety', () => {
  it('keeps the visible Pi catalog on LiteLLM Responses routes', () => {
    const models = JSON.parse(readSource(MODELS_JSON_PATH));
    const kimiEmergency = models.pi.find((m: any) => m.provider === 'openrouter' && m.modelId === 'moonshotai/kimi-k2.6');
    expect(kimiEmergency).toBeTruthy();
    expect(kimiEmergency.enabled).toBe(true);
    expect(kimiEmergency.roles).toEqual(['full']);
    expect(kimiEmergency.badge).toBe('EMERG');
    const smartest = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smartest');
    const smartestLong = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smartest-long');
    const smart = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smart');
    const gpt55 = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'gpt55');
    const mini = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'mini');
    expect(smartest.contextWindow).toBe(353400);
    expect(smartest.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(smartestLong.contextWindow).toBe(760000);
    expect(smartestLong.badge).toBe('LONG');
    expect(smartestLong.cost).toEqual(smartest.cost);
    expect(smart.contextWindow).toBe(353400);
    expect(smart.cost).toEqual({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 });
    expect(gpt55.contextWindow).toBe(258400);
    expect(mini.contextWindow).toBe(258400);
  });

  it('dynamically clamps Chat Completions output tokens instead of hardcoding Kimi low', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/function clampChatCompletionsOutputTokens/);
    expect(src).toMatch(/\$\{tag\} output clamp/);
    expect(src).toMatch(/const tag = isLiteLLMChat \? 'litellm' : 'openrouter'/);
    expect(src).toMatch(/contextWindow - estimatedPrompt - reserve/);
  });

  it('preserves OpenAI Responses output budgets and rejects near-context requests for compaction recovery', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).not.toMatch(/function clampOpenAIResponsesOutputTokens/);
    expect(src).not.toMatch(/responses output clamp/);
    expect(src).toMatch(/PI_RESPONSES_PREFLIGHT_CONTEXT_RATIO \?\? 0\.90/);
    expect(src).toMatch(/context_length_exceeded/);
    expect(src).toMatch(/isGenericOpenAIResponses/);
    expect(src).toMatch(/gpt-5\.6-sol/);
    expect(src).toMatch(/gpt-5\.6-terra/);
    expect(src).toMatch(/smartest-long/);
    expect(src).toMatch(/gpt55/);
    expect(src).toMatch(/760_000/);
    expect(src).toMatch(/353_400/);
    expect(src).toMatch(/258_400/);
  });

  it('keeps retired direct/debug providers out of the Pi model catalog', () => {
    const models = JSON.parse(readSource(MODELS_JSON_PATH));
    expect(models.pi.find((m: any) => m.provider === 'openai-codex')).toBeFalsy();
    expect(models.pi.find((m: any) => m.provider === 'codex-lb')).toBeFalsy();
    const openRouterModels = models.pi.filter((m: any) => m.provider === 'openrouter');
    expect(openRouterModels.map((m: any) => m.modelId)).toEqual([
      'moonshotai/kimi-k2.6',
      'moonshotai/kimi-k3',
    ]);
    expect(openRouterModels.every((m: any) => JSON.stringify(m.roles) === JSON.stringify(['full']))).toBe(true);
    expect(models.pi.find((m: any) => m.provider === 'litellm')).toBeFalsy();
    expect(models.pi.find((m: any) => m.provider === 'azure-openai-responses' && m.modelId === 'gpt-5.4')).toBeFalsy();
  });

  it('normalizes Codex-LB inline <think> tags without exposing reasoning text', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/<\\\/?think>/);
    expect(src).toMatch(/function splitTextByInlineThinkingTags/);
    expect(src).toMatch(/sanitizePiVisibleBlocks/);
    expect(src).toMatch(/agentMessageToTowerBlocks[\s\S]*?splitTextByInlineThinkingTags\(block\.text\)/);
    expect(src).toMatch(/toTowerBlocks\(\)[\s\S]*?sanitizePiVisibleBlocks\(normalizeInlineThinkingTags/);
  });

  it('wires Smartest/Mini routes plus full-VM direct OpenRouter and Azure emergency models', () => {
    const models = JSON.parse(readSource(MODELS_JSON_PATH));
    const smartestResponses = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smartest');
    const smartestLong = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smartest-long');
    const smart = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smart');
    const gpt55 = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'gpt55');
    const mini = models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'mini');
    const kimiEmergency = models.pi.find((m: any) => m.provider === 'openrouter' && m.modelId === 'moonshotai/kimi-k2.6');
    const azureEmergency = models.pi.find((m: any) => m.provider === 'azure-openai-responses-eastus2' && m.modelId === 'gpt-5.5');
    expect(models.claude).toEqual([]);
    expect(models.pi.filter((m: any) => m.provider === 'litellm')).toEqual([]);
    expect(smartestResponses).toBeTruthy();
    expect(smartestResponses.enabled).toBe(true);
    expect(smartestResponses.name).toBe('Smartest');
    expect(smartestResponses.badge).toBe('');
    expect(smartestResponses.roles).toEqual(['full', 'managed', 'standalone']);
    expect(smartestResponses.api).toBe('openai-responses');
    expect(smartestResponses.contextWindow).toBe(353400);
    expect(smartestLong).toBeTruthy();
    expect(smartestLong.name).toBe('Smartest Long Context');
    expect(smartestLong.badge).toBe('LONG');
    expect(smartestLong.roles).toEqual(['full', 'managed', 'standalone']);
    expect(smartestLong.api).toBe('openai-responses');
    expect(smartestLong.contextWindow).toBe(760000);
    expect(smart).toBeTruthy();
    expect(smart.name).toBe('Smart');
    expect(smart.contextWindow).toBe(353400);
    expect(gpt55).toBeTruthy();
    expect(gpt55.name).toBe('GPT-5.5 Legacy');
    expect(gpt55.badge).toBe('5.5');
    expect(gpt55.contextWindow).toBe(258400);
    expect(models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smartest56')).toBeFalsy();
    expect(models.pi.find((m: any) => m.provider === 'litellm-responses' && m.modelId === 'smartest-fast')).toBeFalsy();
    expect(models.defaults.session).toBe('litellm-responses/smartest');
    expect(models.defaults.ai_reply).toBe('litellm-responses/mini');
    expect(models.defaults.ai_task).toBe('litellm-responses/mini');
    expect(mini).toBeTruthy();
    expect(mini.enabled).toBe(true);
    expect(mini.name).toBe('Mini');
    expect(mini.roles).toEqual(['full', 'managed', 'standalone']);
    expect(mini.api).toBe('openai-responses');
    expect(kimiEmergency).toBeTruthy();
    expect(kimiEmergency.roles).toEqual(['full']);
    expect(kimiEmergency.badge).toBe('EMERG');
    expect(kimiEmergency.api).toBe('openai-completions');
    expect(kimiEmergency.contextWindow).toBe(262142);
    expect(kimiEmergency.maxTokens).toBe(245760);
    expect(azureEmergency).toBeTruthy();
    expect(azureEmergency.roles).toEqual(['full']);
    expect(azureEmergency.badge).toBe('EMERG');

    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/getModelDefaults\(\)\.session/);
    expect(src).toMatch(/Using configured default model/);
    expect(src).toMatch(/'openai-responses-compatible': 'openai-responses'/);
    expect(src).toMatch(/const apiKind = m\.api && providerToDefaultApi\[m\.api\]/);
    expect(src).toMatch(/quickReplyLiteLLMResponses/);
    expect(src).toMatch(/Do not inject service_tier=priority for Smartest by default/);
    expect(src).not.toMatch(/serviceTier: 'priority'/);
    expect(src).not.toMatch(/service_tier: 'priority'/);
    expect(src).toMatch(/const defaultThinkingLevel = model\.provider === 'litellm-responses' && \(model\.id === 'smartest' \|\| model\.id === 'smartest-long'\)[\s\S]*?\? 'low'[\s\S]*?: 'medium'/);
    expect(src).toMatch(/thinkingLevel: effectiveThinkingLevel/);
    expect(src).toMatch(/requestedEffort: opts\.requestedEffort \|\| opts\.effort \|\| defaultThinkingLevel/);
    expect(src).toMatch(/reasoning: isReasoningModel \? 'medium' : undefined/);
    expect(src).toMatch(/cost: m\.cost \|\|/);
    expect(src).toMatch(/LITELLM_BASE_URL/);
    expect(src).toMatch(/LITELLM_API_KEY/);
  });

  it('uses one offline-initialized ModelRuntime for Tower model and credential routing', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/ModelRuntime\.create\(\{ modelsPath: null, allowModelNetwork: false \}\)/);
    expect(src).toMatch(/modelRuntimePromise/);
    expect(src).toMatch(/await this\.modelRegistryManager\.getModelRuntime\(\)/);
    expect(src).toMatch(/modelRuntime,/);
    expect(src).not.toMatch(/authStorage:/);
    expect(src).not.toMatch(/ModelRegistry\.inMemory/);
  });

  it('does not inject OPENAI_API_KEY into Pi direct provider unless explicitly opted in', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/function allowPiOpenAiDirect/);
    expect(src).toMatch(/PI_ALLOW_OPENAI_DIRECT/);
    expect(src).toMatch(/OPENAI_API_KEY && allowPiOpenAiDirect\(\)/);
    expect(src).toMatch(/setRuntimeApiKey\('openai', process\.env\.OPENAI_API_KEY,/);
    expect(src).toMatch(/Skipping OpenAI direct model/);
  });

  it('supports steering messages while a Pi prompt is already running', () => {
    const src = readSource(PI_ENGINE_PATH);
    // steer() now records the Tower msgId + username so delivery can be reported
    expect(src).toMatch(/async steer\(sessionId: string, message: string, messageId\?: string, username\?: string \| null\)/);
    expect(src).toMatch(/entry\.session\.steer\(message\)/);
  });

  it('keeps message-id steer idempotency but allows same-text retries up to the third pending steer', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/item\.msgId && item\.msgId === messageId/);
    expect(src).toMatch(/sameTextCount >= 3/);
  });

  it('batches mid-turn injections and reports consumption', () => {
    const src = readSource(PI_ENGINE_PATH);
    // steeringMode 'all' = deliver all pending injections together (issue #17)
    expect(src).toMatch(/steeringMode: 'all'/);
    // queue_update handler turns the SDK's steering-queue diff into steer_delivered
    expect(src).toMatch(/case 'queue_update'/);
    expect(src).toMatch(/type: 'steer_delivered'/);
  });

  it('buffers steers that arrive during the turn startup window (issue #17)', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Messages typed right as a turn starts must buffer (not throw/defer) and be
    // flushed into the same turn once prompt() begins accepting steers.
    expect(src).toMatch(/startupSteerBuffer/);
    expect(src).toMatch(/promptActive/);
    expect(src).toMatch(/buffered \(startup window\)/);
    expect(src).toMatch(/flushed startup-buffered steer/);
  });

  it('terminalizes Pi zombie runs and rejects steers while closing (issue #55)', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/type PiRunPhase/);
    expect(src).toMatch(/forceTerminalizeRun/);
    expect(src).toMatch(/agent_end-carried-error-stuck/);
    expect(src).toMatch(/agent_end-context-overflow-settle-stuck/);
    expect(src).toMatch(/PI_OVERFLOW_COMPACTION_SETTLE_MS/);
    expect(src).toMatch(/skipping promptPromise await after forced terminalization/);
    expect(src).toMatch(/classifyPiSteer/);
  });
});

describe('Pi engine — tool registration', () => {
  it('registers all 7 built-in tools', () => {
    // SDK 0.74 changed from singleton exports (readTool, editTool…)
    // to factory functions (createReadTool, createEditTool…).
    const src = readSource(PI_ENGINE_PATH);
    for (const tool of ['createReadTool', 'createBashTool', 'createEditTool', 'createWriteTool', 'createGrepTool', 'createFindTool', 'createLsTool']) {
      expect(src).toContain(tool);
    }
  });

  it('does not mount the legacy Pi agent custom tool by default', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    expect(assembly).not.toMatch(/createAgentTool\(/);
    expect(assembly).toContain('agent-worker MCP tools');
    expect(assembly).toContain('2026-06-14-subagent-requests-route-to-persistent-workers.md');
  });

  it('registers AskUserQuestion custom tool', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/createAskUserQuestionTool/);
    expect(src).toMatch(/AskUserQuestion/);
  });

  it('registers finance tools (excel_read, excel_query)', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const financeTools = readSource(PI_FINANCE_TOOLS_PATH);
    expect(assembly).toMatch(/createExcelReadTool/);
    expect(assembly).toMatch(/createExcelQueryTool/);
    expect(assembly).toMatch(/projectRoot: sessionProjectRoot/);
    expect(assembly).toMatch(/sessionId/);
    expect(financeTools).toMatch(/runtime_guide_read with name="spreadsheet-analysis"/);
  });

  it('registers web tools (WebFetch, WebSearch)', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/createWebFetchTool/);
    expect(src).toMatch(/createWebSearchTool/);
    expect(src).toMatch(/pi-web-tools/);
  });

  it('registers scoped memory_search continuity tool', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    expect(assembly).toMatch(/createMemorySearchTool/);
    expect(assembly).toMatch(/pi-memory-search-tool/);
    expect(assembly).toMatch(/projectId: opts\.projectId/);
  });

  it('registers scoped conversation_search tool', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    expect(assembly).toMatch(/createConversationSearchTool/);
    expect(assembly).toMatch(/pi-conversation-search-tool/);
    expect(assembly).toMatch(/projectId: opts\.projectId/);
  });

  it('registers read-only session_transcript_read with user access context', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    expect(assembly).toMatch(/createSessionTranscriptReadTool/);
    expect(assembly).toMatch(/pi-session-transcript-tool/);
    expect(assembly).toMatch(/createSessionTranscriptReadTool\(\{ userId: opts\.userId, userRole: opts\.userRole, modelContextWindow: params\.modelContextWindow \}\)/);
  });

  it('keeps ProcessMapWrite as a legacy tool but does not register it by default', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const tool = readSource(PI_PROCESS_MAP_TOOL_PATH);
    expect(assembly).not.toMatch(/createProcessMapWriteTool/);
    expect(tool).toMatch(/name:\s*'ProcessMapWrite'/);
    expect(tool).toMatch(/WorkLedger/);
  });

  it('registers extra tools (pdf_read, excel_write, excel_diff)', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    expect(assembly).toMatch(/createPdfReadTool/);
    expect(assembly).toMatch(/createExcelWriteTool/);
    expect(assembly).toMatch(/createExcelDiffTool/);
    expect(assembly).toMatch(/projectRoot: sessionProjectRoot/);
  });

  it('registers Runtime Box pdf_render as a general PDF vision bridge', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const runtimeTools = readSource(PI_RUNTIME_BOX_TOOLS_PATH);
    expect(assembly).toMatch(/createRuntimeBoxPiTools/);
    expect(runtimeTools).toMatch(/name:\s*'pdf_render'/);
    expect(runtimeTools).toMatch(/read tool/);
    expect(runtimeTools).toMatch(/workspacePathToHostPath/);
  });

  it('records Runtime Box user-facing artifacts into session_file_edits', () => {
    const runtimeTools = readSource(PI_RUNTIME_BOX_TOOLS_PATH);
    expect(runtimeTools).toMatch(/recordFileEdit/);
    expect(runtimeTools).toMatch(/isUserFacingSessionFile/);
    expect(runtimeTools).toMatch(/RUNTIME_BOX_WORKSPACE_PATH_RE/);
    expect(runtimeTools).toMatch(/collectHostPathsFromRuntimeBoxText/);
    expect(runtimeTools).toMatch(/recordRuntimeBoxTouchedFiles\(ctx\.sessionId, 'project_shell'/);
    expect(runtimeTools).toMatch(/recordRuntimeBoxTouchedFiles\(ctx\.sessionId, 'pdf_render'/);
  });

  it('registers pdf_view as a harness-level visual PDF tool', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const pdfView = readSource(PI_PDF_VIEW_TOOL_PATH);
    const pdfAwareRead = readSource(PI_PDF_AWARE_READ_TOOL_PATH);
    expect(assembly).toMatch(/createPdfViewTool/);
    expect(pdfView).toMatch(/name:\s*'pdf_view'/);
    expect(pdfView).toMatch(/Tower internal cache/);
    expect(pdfView).toMatch(/MAX_PAGES_PER_CALL = 100/);
    expect(pdfView).toMatch(/runtime_guide_read with name="pdf-analysis"/);
    expect(pdfView).toMatch(/fitz\.open/);
    expect(pdfAwareRead).toMatch(/renderPdfToCachedImages/);
    expect(pdfAwareRead).not.toMatch(/getOrCreateBox/);
  });

  it('registers pdf_export as the harness-level PDF output contract', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const pdfExport = readSource(PI_PDF_EXPORT_TOOL_PATH);
    expect(assembly).toMatch(/createPdfExportTool/);
    expect(pdfExport).toMatch(/name:\s*'pdf_export'/);
    expect(pdfExport).toMatch(/Chromium/);
    expect(pdfExport).toMatch(/visual verification/);
    expect(pdfExport).toMatch(/runtime_guide_read with name="pdf-export"/);
    expect(pdfExport).toMatch(/renderPdfToCachedImages/);
  });

  it('registers publish_site as the token-free static publishing contract', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const publishTool = readSource(PI_PUBLISH_TOOL_PATH);
    expect(assembly).toMatch(/createPublishSiteTool/);
    expect(publishTool).toMatch(/name:\s*'publish_site'/);
    expect(publishTool).toMatch(/TOWER_API_TOKEN/);
    expect(publishTool).toMatch(/isPathWritableByRole/);
    expect(publishTool).toMatch(/verifyUrl/);
    expect(publishTool).toMatch(/return `\$\{protocol\}\/\/\$\{slug\}\.\$\{host\}\/`/);
    expect(publishTool).not.toMatch(/return `\$\{protocol\}\/\/\$\{host\}\/sites\/\$\{slug\}\//);
  });

  it('registers cad_view as the harness-level CAD visual preview contract', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const cadView = readSource(PI_CAD_VIEW_TOOL_PATH);
    expect(assembly).toMatch(/createCadViewTool/);
    expect(cadView).toMatch(/name:\s*'cad_view'/);
    expect(cadView).toMatch(/ezdxf/);
    expect(cadView).toMatch(/QCAD\/ODA/);
    expect(cadView).toMatch(/runtime_guide_read with name="cad-analysis"/);
    expect(cadView).toMatch(/Tower internal cache/);
  });

  it('keeps harness tools organized by intent-level categories', () => {
    const assembly = readSource(PI_TOOL_ASSEMBLY_PATH);
    const categories = readSource(PI_TOOL_CATEGORIES_PATH);
    expect(assembly).toMatch(/formatPiToolCategorySummary/);
    expect(categories).toMatch(/type PiToolCategory/);
    expect(categories).toMatch(/pdf_view:\s*'view'/);
    expect(categories).toMatch(/cad_view:\s*'view'/);
    expect(categories).toMatch(/excel_read:\s*'analyze'/);
    expect(categories).toMatch(/project_shell:\s*'runtime'/);
    expect(categories).toMatch(/pdf_export:\s*'export'/);
    expect(categories).toMatch(/excel_write:\s*'export'/);
    expect(categories).toMatch(/publish_site:\s*'export'/);
  });
});

describe('Pi engine — ResourceLoader context injection', () => {
  it('uses DefaultResourceLoader with appendSystemPrompt', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/DefaultResourceLoader/);
    expect(src).toMatch(/appendSystemPrompt.*towerPrompt/s);
  });

  it('passes user/project scoped inputs to buildMemoryContext', () => {
    const src = readSource(PI_SESSION_RESOURCES_PATH);
    expect(src).toMatch(/buildMemoryContext\(\{[\s\S]*sessionId/);
    expect(src).toMatch(/userId: opts\.userId/);
    expect(src).toMatch(/projectId: opts\.projectId/);
  });

  it('loads skill paths through the Pi-first materialization adapter', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/getMaterializedSkillPaths/);
    expect(src).toMatch(/runtime: 'pi'/);
  });

  it('calls buildSystemPrompt with user identity', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/buildSystemPrompt/);
    expect(src).toMatch(/opts\.userId/);
    expect(src).toMatch(/opts\.username/);
    expect(src).toMatch(/opts\.userRole/);
  });
});

describe('Pi engine — tool input normalization', () => {
  it('defines normalizeToolInput function', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/function normalizeToolInput\(/);
  });

  it('normalizes path → file_path for file tools (Read, Write, Edit)', () => {
    const src = readSource(PI_ENGINE_PATH);
    // FILE_TOOLS set should include Read, Write, Edit
    expect(src).toMatch(/FILE_TOOLS.*Read.*Write.*Edit|FILE_TOOLS.*read.*write.*edit/is);
    // normalizeToolInput should map path → file_path
    expect(src).toMatch(/input\.path && !input\.file_path/);
    expect(src).toMatch(/file_path: input\.path/);
  });

  it('applies normalization in addToolUse', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/normalizeToolInput\(toolCall\.name, toolCall\.arguments\)/);
  });

  it('applies normalization in piBlocksToTower / agentMessageToTowerBlocks', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Should normalize in the static block conversion too
    expect(src).toMatch(/normalizeToolInput\(block\.name/);
  });
});

describe('Pi finance tools — excel_read', () => {
  it('supports .xlsm files', () => {
    const src = readSource(PI_FINANCE_TOOLS_PATH);
    expect(src).toMatch(/\.xlsm/);
    expect(src).toMatch(/keep_vba/);
  });

  it('handles Korean filename encoding via glob fallback', () => {
    const src = readSource(PI_FINANCE_TOOLS_PATH);
    expect(src).toMatch(/glob/);
    expect(src).toMatch(/ext_match/);
  });

  it('extracts formulas from Excel files', () => {
    const src = readSource(PI_FINANCE_TOOLS_PATH);
    expect(src).toMatch(/formula_map/);
    expect(src).toMatch(/data_only=False/);
  });

  it('resolves theme colors to readable names', () => {
    const src = readSource(PI_FINANCE_TOOLS_PATH);
    expect(src).toMatch(/theme_names/);
    expect(src).toMatch(/accent-teal|accent-blue|white-bg/);
  });

  it('extracts bold/italic formatting per row', () => {
    const src = readSource(PI_FINANCE_TOOLS_PATH);
    expect(src).toMatch(/fc\.font\.bold/);
    expect(src).toMatch(/fc\.font\.italic/);
  });

  it('uses per-call Python temp files instead of fixed singleton paths', () => {
    const src = readSource(PI_FINANCE_TOOLS_PATH);
    expect(src).toMatch(/runPython\(pyScript/);
    expect(src).toMatch(/fs\.mkdtempSync/);
    expect(src).toMatch(/crypto\.randomUUID/);

    // Should not use execSync with python3 -c or shared /tmp script names for execution.
    expect(src).not.toMatch(/execSync\(`python3 -c/);
    expect(src).not.toMatch(/\/tmp\/tower_py_run\.py/);
    expect(src).not.toMatch(/\/tmp\/tower_excel_reader\.py/);
    expect(src).not.toMatch(/require\('fs'\)/);
  });
});

describe('Pi finance tools — extra (pdf, write, diff)', () => {
  it('pdf_read handles Korean parenthetical negatives', () => {
    const src = readSource(PI_FINANCE_EXTRA_PATH);
    expect(src).toMatch(/clean_number|parenthetical/i);
    expect(src).toMatch(/runtime_guide_read with name="pdf-analysis"/);
    expect(src).toMatch(/runtime_guide_read with name="spreadsheet-analysis"/);
  });

  it('excel_write creates formatted output with bold headers', () => {
    const src = readSource(PI_FINANCE_EXTRA_PATH);
    expect(src).toMatch(/Font.*bold/);
    expect(src).toMatch(/auto_filter|freeze_panes/);
  });

  it('excel_diff supports key_column matching', () => {
    const src = readSource(PI_FINANCE_EXTRA_PATH);
    expect(src).toMatch(/key_col/);
    expect(src).toMatch(/delta_pct|delta/);
  });

  it('uses per-call Python temp files instead of fixed singleton paths', () => {
    const src = readSource(PI_FINANCE_EXTRA_PATH);
    expect(src).toMatch(/runPython\(/);
    expect(src).toMatch(/fs\.mkdtempSync/);
    expect(src).toMatch(/crypto\.randomUUID/);
    expect(src).toMatch(/resolveExcelInputPath/);
    expect(src).not.toMatch(/execSync.*python3 -c/);
    expect(src).not.toMatch(/\/tmp\/tower_py_run\.py/);
    expect(src).not.toMatch(/\/tmp\/tower_excel_reader\.py/);
    expect(src).not.toMatch(/sys\.path\.insert\(0, '\/tmp'\)/);
  });
});

describe('Pi models config', () => {
  it('models.json has a non-empty pi array', () => {
    const data = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf-8'));
    expect(data.pi).toBeInstanceOf(Array);
    expect(data.pi.length).toBeGreaterThan(0);
  });

  it('each pi model has required fields', () => {
    const data = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf-8'));
    for (const m of data.pi) {
      expect(m).toHaveProperty('provider');
      expect(m).toHaveProperty('modelId');
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('badge');
      expect(m).toHaveProperty('enabled');
    }
  });
});

describe('Pi session persistence — source contracts', () => {
  it('pi-engine uses SessionManager.create with .pi/sessions dir', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Should create session dir and use file-based persistence
    expect(src).toMatch(/piSessionDir.*\.pi.*sessions/s);
    expect(src).toMatch(/mkdirSync.*piSessionDir/);
    expect(src).toMatch(/SessionManager\.create\(.*piSessionDir\)/);
  });

  it('uses pi-session-runtime helper for backup and recovery', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/backupPiSessionFile/);
    expect(src).toMatch(/preparePiResumeSession/);
    expect(src).toMatch(/consumeInterruptedPiSessions|gracefulPiShutdown/);
  });

  it('resume path uses SessionManager.open with engineSessionId', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/SessionManager\.open\(resumeSessionFile/);
  });

  it('claims session file path after creation', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/sessionMgr\.getSessionFile/);
    expect(src).toMatch(/callbacks\.claimSessionId\(sessionFile\)/);
  });

  it('backs up session file after creation or completion', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/backupPiSessionFile\(/);
  });

  it('ws-handler normalizes retired Pi session models before running the engine', () => {
    const wsHandlerSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf-8'
    );
    expect(wsHandlerSrc).toMatch(/normalizePiSessionModelId/);
    expect(wsHandlerSrc).toMatch(/engineName === 'pi'/);
    expect(wsHandlerSrc).toMatch(/Pi model migration/);
  });

  it('ws-handler re-reads Pi session row before run so DB recovery pointer wins over stale client state', () => {
    const wsHandlerSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf-8'
    );
    expect(wsHandlerSrc).toMatch(/For Pi, re-read the DB row immediately before engine\.run/);
    expect(wsHandlerSrc).toMatch(/if \(engineName === 'pi'\) \{\s*try \{ dbSession = await getSession\(sessionId\) \?\? dbSession; \} catch \{\}\s*\}/);
    expect(wsHandlerSrc).toMatch(/const dbEngineSessionId = getEngineSessionId\(dbSession\) \|\| undefined/);
    expect(wsHandlerSrc).toMatch(/const engineSessionId = engineName === 'pi'\s*\? dbEngineSessionId\s*:\s*\(clientEngineSessionId \|\| dbEngineSessionId\)/);
  });

  it('ws-handler persists engineSessionId to the active engine column on engine_done', () => {
    const wsHandlerSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf-8'
    );
    // engine_done handler should dispatch through the engine-aware claim helper.
    expect(wsHandlerSrc).toMatch(/engine_done[\s\S]*?claimActiveEngineSessionId/);
  });

  it('ws-handler clears pending ask-user state on abort and sanitizes empty question payloads', () => {
    const wsHandlerSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf-8'
    );
    expect(wsHandlerSrc).toMatch(/cancelPendingQuestionsForSession\(sessionId, 'Session aborted'\)/);
    expect(wsHandlerSrc).toMatch(/sanitizeAskUserQuestions/);
    expect(wsHandlerSrc).toMatch(/ask_user dropped empty payload/);
  });
});

// ──────────────────────────────────────────────────────────────────
// Stream stuck mid-iteration guards — 2026-05-17 73c1fbcf prod case
// (Kimi K2.6 / OpenRouter: thinking + toolcall deltas streamed for 23 min
// without message_end; user had to abort manually). Decision:
// workspace/decisions/2026-05-17-pi-stream-stuck-mid-iteration.md
// ──────────────────────────────────────────────────────────────────

describe('Pi stream watchdog — source contracts', () => {
  it('settings forward provider.timeoutMs to SDK 0.74', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/provider:\s*\{\s*timeoutMs:\s*\d+/);
  });

  it('run() installs block-level stream watchdog (createStreamWatchdog)', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/createStreamWatchdog\(/);
    expect(src).toMatch(/streamIdleMs:/);
    expect(src).toMatch(/blockTimeoutMs:/);
    expect(src).toMatch(/watchdog\.stop\(\)/);
  });

  it('watchdog tunable via PI_STREAM_IDLE_MS + PI_BLOCK_TIMEOUT_MS env', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/process\.env\.PI_STREAM_IDLE_MS/);
    expect(src).toMatch(/process\.env\.PI_BLOCK_TIMEOUT_MS/);
  });

  it('subscribe handler routes every event into watchdog.observe()', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/entry\.session\.subscribe\(\(event:\s*any\)\s*=>\s*\{\s*watchdog\.observe\(event\)/);
  });

  it('watchdog onStuck calls entry.session.abort()', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/onStuck:[\s\S]*?entry\.session\.abort\(\)/);
  });

  it('watchdog-triggered abort surfaces engine_error with Korean reason', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/스트림 무응답/);
    // Each block-stuck reason has its own Korean message; check at least one
    expect(src).toMatch(/Thinking 단계가.*초 동안 종료 신호 없음|Text 응답이.*초 동안|Tool call 생성이.*초 동안/);
    expect(src).toMatch(/recoverable:\s*true/);
  });

  it('block-level reasons cover thinking / text / toolcall stuck', () => {
    const src = readSource(PI_ENGINE_PATH);
    // formatWatchdogReason switches on StuckReason discriminant
    expect(src).toMatch(/case 'thinking-stuck'/);
    expect(src).toMatch(/case 'text-stuck'/);
    expect(src).toMatch(/case 'toolcall-stuck'/);
  });

  it('closing-phase terminalizer is gated by markClosing and cleared in cleanup', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/PI_CLOSING_TERMINALIZE_MS/);
    expect(src).toMatch(/const markClosing = \(why: string, terminalStopOverride\?: 'error' \| 'aborted', timeoutMs = CLOSING_TERMINALIZE_MS\) => \{[\s\S]*?closingTerminalizerTimer = setTimeout/);
    expect(src).toMatch(/if \(!promptSettled && !terminalizer\.isTerminalForced\) \{[\s\S]*?forceTerminalizeRun\(`closing-timeout:\$\{why\}`, terminalStopOverride \?\? \(entry\.abortRequested \? 'aborted' : 'error'\)\)/);
    expect(src).toMatch(/timeout=\$\{timeoutMs\}ms/);
    expect(src).toMatch(/const clearClosingTerminalizer = \(\) => \{/);
    expect(src).toMatch(/promptSettled = true;\s*lifecycleShadow\.observePromptSettled\(Boolean\(entry\.session\.isIdle\)\);\s*clearClosingTerminalizer\(\);/);
    expect(src).toMatch(/watchdog\.stop\(\);[\s\S]*?clearClosingTerminalizer\(\);/);
  });

  it('emits turn_status events for tool-running phase hints and heartbeat', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/type: 'turn_status'/);
    expect(src).toMatch(/emitTurnStatus\('tool_running'/);
    expect(src).toMatch(/emitTurnStatus\('running'/);
    expect(src).toMatch(/activeToolName/);
    expect(src).toMatch(/PI_TOOL_HEARTBEAT_MS/);
    expect(src).toMatch(/ensureToolHeartbeat/);
    expect(src).toMatch(/clearToolHeartbeat/);
  });

  it('records private structural trace signals without putting raw thinking in messages', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/recordPrivateTrace\('thinking_start'/);
    expect(src).toMatch(/recordPrivateTrace\('thinking_end'/);
    expect(src).toMatch(/recordPrivateTrace\('commentary_signal'/);
    expect(src).toMatch(/recordPrivateTrace\('progress_status'/);
    expect(src).not.toMatch(/recordPrivateTrace\('thinking_signal'[\s\S]*thinking_delta/);
  });

  it('wires private trace recording through ws-handler callbacks', () => {
    const wsSrc = readSource(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'));
    expect(wsSrc).toMatch(/recordAiRunTraceEvent/);
    expect(wsSrc).toMatch(/recordTraceEvent: async \(event\)/);
    expect(wsSrc).toMatch(/rootTurnId: userMsgId/);
    expect(wsSrc).toMatch(/rootTurnId: userMessageId \|\| null/);
  });

  it('keeps recovered Codex fallback provider errors out of visible engine_error bubbles', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/!isCodexUsageLimit && !isCodexAuthInvalid/);
    expect(src).toMatch(/Recovered Codex fallback is an implementation detail/);
    expect(src).not.toMatch(/message: `Codex 연결 문제로 fallback 모델/);
  });

  it('emits structured PiRunSummary telemetry at turn boundary', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/\[PiRunSummary\]/);
    expect(src).toMatch(/failureClass/);
    expect(src).toMatch(/toolCallsForTelemetry/);
    expect(src).toMatch(/autoResume=\$\{state\.autoResume\}/);
    expect(src).toMatch(/terminalForced=\$\{this\.terminalForced\}/);
    expect(src).toMatch(/suppressed=\$\{state\.transientAbortVisibleSuppressed\}/);
    expect(src).toMatch(/ctxActual=\$\{actualContextInputTokens\}\/\$\{runCtx\.modelContextWindow\}/);
    expect(src).toMatch(/ctxRisk=\$\{riskContextEstimateTokens\}\/\$\{runCtx\.modelContextWindow\}/);
  });

  it('marks server-side restart recovery runs as autoResume in engine opts', () => {
    const wsSrc = readSource(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'));
    const engineSrc = readSource(PI_ENGINE_PATH);
    expect(wsSrc).toMatch(/autoResume:\s*true/);
    expect(wsSrc).toMatch(/autoResumeReason:\s*'server-restart'/);
    expect(engineSrc).toMatch(/autoResumeRun\s*=\s*Boolean\(opts\.autoResume\)/);
    expect(engineSrc).toMatch(/SERVER_RESTART_RECOVERY_PROMPT/);
    expect(engineSrc).not.toMatch(/AUTO_RESUME_TRANSIENT_NOTICE_TEXT/);
  });

  it('routes server-side restart recovery by Pi leaf role without native-continuing an assistant leaf', () => {
    const wsSrc = readSource(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'));
    const engineSrc = readSource(PI_ENGINE_PATH);
    expect(wsSrc).toMatch(/engine\.run\(sessionId, AUTO_RESUME_NATIVE_PROMPT/);
    expect(wsSrc).toMatch(/autoResume:\s*true/);
    expect(wsSrc).toMatch(/autoResumeReason:\s*'server-restart'/);
    expect(engineSrc).toMatch(/const restartDecision = decidePiRestartRecovery\(recoveryState\)/);
    expect(engineSrc).toMatch(/restartDecision\.action === 'native_continue'[\s\S]{0,240}continueWithPiNativeLifecycle/);
    expect(engineSrc).toMatch(/restartDecision\.action === 'recovery_prompt'[\s\S]{0,240}promptWithFetchCorrelation\(SERVER_RESTART_RECOVERY_PROMPT\)/);
    expect(engineSrc.match(/settlePiRecoveryOutcome\(\{/g)).toHaveLength(2);
    expect(engineSrc).toMatch(/executionError: message[\s\S]{0,300}complete: completeRecoveryClaim[\s\S]{0,200}release: releaseRecoveryClaim/);
    expect(engineSrc).not.toMatch(/if \(opts\.autoResume && recoveryClaimToken\) \{\s*if \(stopReason === 'stop'/);
    expect(engineSrc).not.toMatch(/if \(isAbortError\) await completeRecoveryClaim\('failed'/);
    expect(engineSrc).not.toMatch(/if \(autoResumeRun\) \{\s*await continueWithPiNativeLifecycle/);
    expect(wsSrc).not.toContain("hidden: 'server-resume'");
    expect(wsSrc).not.toContain('Internal server-restart continuation.');
    expect(wsSrc).not.toContain('tower-prod 재시작 후 세션이 복구되었습니다');
    expect(wsSrc).not.toContain('prod-restart-committed');
    expect(wsSrc).not.toContain('status 등으로 상태만 확인');
  });

  it('makes server-side restart recovery observable and duplicate-safe without writing session notices', () => {
    const wsSrc = readSource(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'));
    expect(wsSrc).toMatch(/AUTO_RESUME_MAX_ATTEMPTS\s*=\s*4/);
    expect(wsSrc).toMatch(/autoResumeSessionsInFlight/);
    expect(wsSrc).toContain('START recovered=');
    expect(wsSrc).toContain('retry reason=concurrent_limit');
    expect(wsSrc).toContain('no_assistant=true');
    expect(wsSrc).toContain('summarizeAutoResumeMessageCounts');
    expect(wsSrc).toContain('auto_resume_completed');
    expect(wsSrc).toContain('session_refresh_needed');
  });

  it('guards committed prod restart detached phase with a process lock', () => {
    const scriptSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../scripts/prod-restart-committed.sh'), 'utf-8');
    expect(scriptSrc).toContain('RUN_LOCK_DIR="/tmp/tower-prod-restart.running"');
    expect(scriptSrc).toContain('tower-prod restart is already running');
    expect(scriptSrc).toContain('trap cleanup_lock EXIT');
  });

  it('recovers DB-checkpointed orphan turns that did not reach a visible assistant row', () => {
    const indexSrc = readSource(path.resolve(import.meta.dirname, '../../index.ts'));
    const wsSrc = readSource(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'));
    const storeSrc = readSource(path.resolve(import.meta.dirname, '../../services/message-store.ts'));
    expect(storeSrc).toMatch(/markAgentTurnCheckpoint/);
    expect(storeSrc).toMatch(/findOrphanedStartedAgentTurns/);
    expect(indexSrc).toMatch(/findOrphanedStartedAgentTurns/);
    expect(indexSrc).toContain('db-agent-turn-checkpoint');
    expect(storeSrc).toContain("WHERE s.engine = 'pi'");
    expect(wsSrc).toMatch(/engine\.run\(sessionId, AUTO_RESUME_NATIVE_PROMPT/);
    expect(wsSrc).toMatch(/userMessageId/);
    expect(wsSrc).toMatch(/markAgentTurnCheckpoint\(userMessageId/);
    expect(indexSrc).not.toContain('Original user request:');
  });

  it('resumes a native Pi session only from its existing pinned Harness contract', () => {
    const src = readSource(PI_ENGINE_PATH);
    const storeSrc = readSource(path.resolve(import.meta.dirname, '../../services/harness/harness-store.ts'));

    expect(src).toMatch(/opts\.engineSessionId\s*\?\s*await getPinnedSessionHarnessSnapshot/);
    expect(src).toMatch(/:\s*await getOrPinSessionHarnessSnapshot/);
    expect(storeSrc).toMatch(/export async function getPinnedSessionHarnessSnapshot/);
    expect(storeSrc).toContain('Pinned Harness snapshot is required to resume Session');
  });

  it('rechecks the pinned Harness model allowlist on later turns', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/entry\.harness\?\.allowedModels/);
    expect(src).toMatch(/!entry\.harness\.allowedModels\.includes\(modelStr\)/);
    expect(src).toContain('does not allow model ${modelStr}');
  });

  it('preserves the stored session model during server-side auto-resume', () => {
    const wsSrc = readSource(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'));
    expect(wsSrc).toMatch(/function resolveAutoResumeModel/);
    expect(wsSrc).toMatch(/const autoResumeModel = resolveAutoResumeModel\(dbSession, engineName\)/);
    expect(wsSrc).toMatch(/model: autoResumeModel/);
    expect(wsSrc).toMatch(/candidateModel = towerMsg\.model \|\| autoResumeModel/);
  });

  it('requires SDK compaction results to persist as Pi compaction entries or creates a local fallback', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/countPiCompactionEntries/);
    expect(src).toMatch(/createPiLocalFallbackCompaction/);
    expect(src).toMatch(/compactionEntriesAtRunStart/);
    expect(src).toMatch(/sdkCompactionSucceededEventsThisTurn/);
    expect(src).toMatch(/local fallback compaction created after SDK no-result compaction/);
    expect(src).toMatch(/local fallback compaction created after compact\(\) no-persist/);
  });

  it('appends Tower file-ledger checkpoints after successful Pi compaction paths', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/appendTowerFileLedgerCheckpoint/);
    expect(src).toMatch(/const towerFileLedgerCheckpointPromises: Promise<void>\[] = \[]/);
    expect(src).toMatch(/const appendTowerFileLedgerAfterCompaction = \(reason: string\): Promise<void>/);
    expect(src).toMatch(/await Promise\.allSettled\(towerFileLedgerCheckpointPromises\)/);
    expect(src).toMatch(/void appendTowerFileLedgerAfterCompaction\(`sdk-event:/);
    expect(src).toMatch(/await appendTowerFileLedgerAfterCompaction\(`proactive:\$\{source\}`\)/);
    expect(src).toMatch(/await appendTowerFileLedgerAfterCompaction\('oversized-preflight-recovery'\)/);
    expect(src).toMatch(/reason: 'manual-compact'/);
  });

  it('persists and visibly fails compaction instead of showing a false compact-done marker', () => {
    const src = readSource(PI_ENGINE_PATH);
    const typesSrc = readSource(path.resolve(import.meta.dirname, '../types.ts'));
    const frontendSrc = readSource(path.resolve(import.meta.dirname, '../../../frontend/src/hooks/useChatRuntime.ts'));
    expect(typesSrc).toMatch(/'boundary' \| 'compacting' \| 'done' \| 'skipped' \| 'failed'/);
    expect(src).toMatch(/let compactionFailureNoticeSaved = false/);
    expect(src).toMatch(/let compactionRecoveryNoticeSaved = false/);
    expect(src).toMatch(/const persistCompactionFailureNotice = \(reason: string\)/);
    expect(src).toMatch(/const persistCompactionRecoveryNotice = \(reason: string\)/);
    expect(src).toMatch(/컨텍스트 자동 정리를 시도했지만 완료하지 못했습니다/);
    expect(src).toMatch(/Tower가 로컬 복구 정리를 적용했습니다/);
    expect(src).toMatch(/emitRecoveryCompactFailedIfNeeded\('oversized-preflight-recovery-error'\)/);
    expect(src).not.toMatch(/emitRecoveryCompactDoneIfNeeded\('oversized-preflight-recovery-error'\)/);
    expect(frontendSrc).toMatch(/towerMsg\.phase === 'failed'/);
    expect(frontendSrc).toMatch(/컨텍스트 자동 정리에 실패했습니다/);
  });

  it('treats Nothing to compact as a non-fatal skip and avoids unsafe direct continuation', () => {
    const src = readSource(PI_ENGINE_PATH);
    const frontendSrc = readSource(path.resolve(import.meta.dirname, '../../../frontend/src/hooks/useChatRuntime.ts'));
    expect(src).toMatch(/isPiCompactionNoOpMessage/);
    expect(src).toMatch(/phase: 'skipped'/);
    expect(src).toMatch(/compaction no-op accepted/);
    expect(src).toMatch(/oversized preflight compaction was a no-op after work started; attempting safe continuation without replay/);
    expect(src).toMatch(/runPostCompactContinuationOnce\('oversized-preflight-noop', \{ requireCompaction: false \}\)/);
    expect(frontendSrc).toMatch(/towerMsg\.phase === 'skipped'/);
    expect(frontendSrc).toMatch(/markSessionRunActive\(sid, 'streaming'\)/);
  });

  it('attempts at most one safe continuation after compaction plus abnormal interruption', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/let postCompactContinuationAttempted = false/);
    expect(src).toMatch(/const shouldAttemptPostCompactContinuation = \(requireCompaction = true\) =>[\s\S]*?!requireCompaction \|\| runCtx\.compactionSucceededThisTurn[\s\S]*?!postCompactContinuationAttempted[\s\S]*?!entry\.abortRequested[\s\S]*?!watchdogAborted/);
    expect(src).toMatch(/const runPostCompactContinuationOnce = async/);
    expect(src).toMatch(/postCompactContinuationAttempted = true/);
    expect(src).toMatch(/post-compact continuation after abnormal interruption/);
    expect(src).toMatch(/runPostCompactContinuationOnce\('prompt-rejected'\)/);
    expect(src).toMatch(/runPostCompactContinuationOnce\('transient-retry-exhausted'\)/);
  });

  it('executes Tower pre-prompt compaction when proactive pressure crosses threshold', () => {
    const src = readSource(PI_ENGINE_PATH);
    const policySrc = readSource(path.resolve(import.meta.dirname, '../pi/proactive-compaction.ts'));
    expect(src).toMatch(/shouldProactivelyCompactPiSession/);
    expect(src).toMatch(/const compactSessionBeforePromptIfNeeded = async/);
    expect(src).toMatch(/compaction advisory before prompt/);
    expect(src).toMatch(/execution=disabled-env/);
    expect(src).toMatch(/Tower proactive compaction before prompt/);
    expect(policySrc).toMatch(/PI_TOWER_PROACTIVE_COMPACTION_EXECUTION === '0'/);
    expect(src).toMatch(/await compactSessionBeforePromptIfNeeded\('initial'\)/);
  });
});

// ──────────────────────────────────────────────────────────────────
// Transient transport abort recovery — 2026-05-27 / GitHub issue #43
// Provider/SSE aborts such as "Request was aborted" are usually safe to retry,
// unlike OAuth expiry or explicit user stops. Keep this bounded and visible on
// final failure so the frontend can offer a manual retry fallback.
// ──────────────────────────────────────────────────────────────────

describe('Pi transient abort auto-retry', () => {
  it('classifies transport/SSE aborts as retryable but excludes auth and user aborts', () => {
    const engineSrc = readSource(PI_ENGINE_PATH);
    const classifierSrc = readSource(PI_FAILURE_CLASSIFIER_PATH);
    expect(engineSrc).toMatch(/function isPiTransientAbortError/);
    expect(engineSrc).toMatch(/classifyPiFailure/);
    expect(classifierSrc).toMatch(/Request was aborted|request was aborted/i);
    expect(classifierSrc).toMatch(/This operation was aborted|this operation was aborted/i);
    expect(classifierSrc).toMatch(/SSE .*terminated|sse .*terminated/i);
    // Mid-stream SSE/websocket truncation from the LiteLLM/codex-lb path must
    // be retryable too — incident 2026-05-29/30.
    expect(classifierSrc).toMatch(/stream_incomplete/i);
    expect(classifierSrc).toMatch(/upstream websocket closed/i);
    expect(engineSrc).toMatch(/function isPiAuthOrUserActionError/);
    expect(classifierSrc).toMatch(/invalidated oauth/);
    expect(classifierSrc).toMatch(/BadRequestError:\\s\*request aborted|badrequesterror/);
  });

  it('lets Pi SDK own retry after native retry lifecycle events', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/let sdkRetryObservedThisRun = false/);
    expect(src).toMatch(/case 'auto_retry_start': \{[\s\S]{0,240}sdkRetryObservedThisRun = true/);
    expect(src).toMatch(/case 'auto_retry_end': \{[\s\S]{0,160}sdkRetryObservedThisRun = true/);
    expect(src).toMatch(/const ownership = decidePiRetryOwnership\(sdkRetryObservedThisRun\)/);
    expect(src).toMatch(/if \(!ownership\.towerRetryAllowed\) \{[\s\S]{0,320}transientAbortRetryRequested = false/);
    expect(src).toMatch(/suppressing Tower retry after SDK ownership/);
  });

  it('retries transient aborts with bounded backoff and no user-stop retry', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/TRANSIENT_ABORT_RETRY_MAX/);
    expect(src).toMatch(/TRANSIENT_ABORT_RETRY_BACKOFF_MS/);
    expect(src).toMatch(/auto-retry transient\/provider retryable error/);
    expect(src).toMatch(/transientAbortRetryAttempts\s*<\s*getTransientAbortRetryMax\(transientAbortRetryMessage\)/);
    expect(src).toMatch(/!entry\.abortRequested/);
    expect(src).toMatch(/toolCallsForTelemetry === 0/);
    expect(src).toMatch(/retryUsesOriginalPrompt[\s\S]*?promptWithFetchCorrelation\(prompt\)[\s\S]*?continueWithPiNativeLifecycle\('transient retry after started work'\)/);
  });

  it('waits once for router restart style connection drops before retrying', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/ROUTER_RESTART_RETRY_BACKOFF_MS/);
    expect(src).toMatch(/function isGenericConnectionDrop/);
    expect(src).toMatch(/connection error/);
    expect(src).toMatch(/cannot connect to host/);
    expect(src).toMatch(/function getTransientAbortRetryMax/);
    expect(src).toMatch(/if \(isGenericConnectionDrop\(message\)\) return 0/);
    expect(src).toMatch(/isPiCapacityThrottleFailure\(message\)/);
    expect(src).toMatch(/function getTransientAbortRetryDelayMs/);
    expect(src).toMatch(/ROUTER_RESTART_RETRY_BACKOFF_MS/);
    expect(src).toMatch(/clearClosingTerminalizer\(\);\n\s*clearAgentEndTerminalizer\(\);\n\s*entry\.runPhase = 'running';\n\s*entry\.promptActive = true;/);
  });

  it('does not let stale agent_end terminalizers kill transient retries', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/let agentEndTerminalizerTimer/);
    expect(src).toMatch(/const clearAgentEndTerminalizer/);
    expect(src).toMatch(/agentEndCarriedError && !agentEndIsCodexUsageLimit && !agentEndIsTransientRetry && !transientAbortRetryRequested/);
    expect(src).toMatch(/!promptSettled && !terminalizer\.isTerminalForced && !transientAbortRetryRequested/);
    expect(src).toMatch(/promptSettled = true;\n\s*lifecycleShadow\.observePromptSettled\(Boolean\(entry\.session\.isIdle\)\);\n\s*clearClosingTerminalizer\(\);\n\s*clearAgentEndTerminalizer\(\);/);
  });

  it('preserves transient stream failures as aborted so resolved prompts cannot become clean empty completions', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const suppressTransientAbortVisibleError[\s\S]*?stopReason = 'aborted'/);
    expect(src).toMatch(/const surfaceTransientAbortFailure[\s\S]*?stopReason = 'aborted'/);
    expect(src).toMatch(/stream_incomplete\/upstream truncation[\s\S]*?successful empty completion/);
  });

  it('gives context-overflow compaction a five-minute settle window and preserves provider errors', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/OVERFLOW_COMPACTION_SETTLE_MS/);
    expect(src).toMatch(/5 \* 60_000/);
    expect(src).toMatch(/overflowCompactionInProgress = true/);
    expect(src).toMatch(/compactionNoticeEmittedThisTurn/);
    expect(src).toMatch(/duplicate compaction_start suppressed from UI/);
    expect(src).toMatch(/alreadyCompactedThisTurn = runCtx\.compactionSucceededThisTurn && !overflowCompactionInProgress/);
    expect(src).toMatch(/reusing SDK compaction already completed this turn/);
    expect(src).toMatch(/emitRecoveryCompactStart\('oversized-preflight-recovery'\)/);
    expect(src).toMatch(/emitRecoveryCompactDoneIfNeeded\('oversized-preflight-recovery'\)/);
    expect(src).toMatch(/continueWithPiNativeLifecycle/);
    expect(src).not.toMatch(/makePostCompactContinuationPrompt/);
    expect(src).toMatch(/attempting safe post-compact recovery without replaying original prompt/);
    expect(src).not.toMatch(/컨텍스트가 커져서 자동으로 정리했습니다\. 이어서 진행해 주세요/);
    expect(src).toMatch(/요약용 모델 슬롯이 일시적으로 가득 찼습니다/);
    expect(src).toMatch(/agentEndNeedsOverflowSettle = isPreflightOversized \|\| isContextOverflow \|\| isUpstreamRejectedInput \|\| overflowCompactionInProgress \|\| overflowCompactionObservedThisTurn/);
    expect(src).toMatch(/createPiCompactRecoverySessionFile/);
    expect(src).toMatch(/compactRecoverySessionFile \|\| entry\.session\.sessionFile/);
    expect(src).toMatch(/kept history가 여전히 너무 큽니다/);
    expect(src).toMatch(/agent_end-context-overflow-settle/);
    expect(src).toMatch(/providerErrorMustRemainError = true/);
    expect(src).toMatch(/stopReason === 'error' && !providerErrorMustRemainError/);
    expect(src).toMatch(/isPiUpstreamRejectedInputFailure/);
    expect(src).toMatch(/getPiResponsesRequestDebugInfo/);
    expect(src).toMatch(/requestDebug/);
    expect(src).toMatch(/agent_end provider rejection observation/);
    expect(src).toMatch(/providerErrorVisibleSurfacedThisTurn/);
    expect(src).toMatch(/suppressing duplicate agent_end provider error/);
  });

  it('injects Tower correlation metadata into LiteLLM Responses requests', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/AsyncLocalStorage/);
    expect(src).toMatch(/const piFetchCorrelation = new AsyncLocalStorage/);
    expect(src).toMatch(/function injectTowerCorrelationMetadata/);
    expect(src).toMatch(/tower_session_id: ctx\.sessionId/);
    expect(src).toMatch(/tower_run_id: ctx\.runId/);
    expect(src).toMatch(/isLiteLLMResponses[\s\S]*?injectTowerCorrelationMetadata/);
    expect(src).toMatch(/promptWithFetchCorrelation/);
    expect(src).toMatch(/recordPiResponsesRequestDebugInfo/);
    expect(src).toMatch(/bodyEstimatedPromptTokens/);
    expect(src).toMatch(/getPiContextTokenHint/);
    expect(src).toMatch(/requestBodyEstimate/);
    expect(src).toMatch(/hintedEstimate/);
    expect(src).toMatch(/previousResponseId/);
    expect(src).toMatch(/Pi Responses preflight rejected near-context request/);
    expect(src).toMatch(/PI_RESPONSES_PREFLIGHT_CONTEXT_RATIO/);
    expect(src).toMatch(/PI_RESPONSES_REQUEST_DEBUG/);
  });

  it('injects opaque prompt_cache_key for LiteLLM Responses cache affinity', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/pcache:v2:litellm-responses:/);
    expect(src).toMatch(/createHmac\('sha256', secret\)/);
    expect(src).toMatch(/buildTowerPromptCacheKey/);
    expect(src).toMatch(/ensureLiteLLMResponsesPromptCacheKey/);
    expect(src).toMatch(/promptCacheSessionId: providerCacheSessionId/);
    expect(src).toMatch(/logicalSessionId/);
    expect(src).toMatch(/stripCodexSessionHeader/);
    expect(src).toMatch(/x-codex-session-id/);
  });

  it('enables Responses preflight rejection by default so Tower can compact before upstream', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/PI_RESPONSES_PREFLIGHT_CONTEXT_RATIO \?\? 0\.90/);
    expect(src).toMatch(/synthetic non-retryable provider-style 400/);
    expect(src).toMatch(/context_length_exceeded/);
  });

  it('uses the closing settle window for post-side-effect transient agent_end errors', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/let agentEndIsTransientAbort = false/);
    expect(src).toMatch(/agentEndIsTransientAbort = analysis\.isTransientAbort/);
    expect(src).toMatch(/agentEndIsTransientAbort \|\| transientAbortVisibleSuppressed/);
    expect(src).toMatch(/markClosing\('agent_end-transient-transport', 'aborted'\)/);
    expect(src).toMatch(/Post-side-effect transport drops are already classified as transient/);
  });

  it('continues once after post-side-effect transient transport failures instead of surfacing a stop', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/surfaceTransientAbortFailure/);
    expect(src).toMatch(/suppressTransientAbortVisibleError/);
    expect(src).toMatch(/transientAbortVisibleSuppressed/);
    expect(src).toMatch(/transientAbortRetryMessage/);
    expect(src).toMatch(/let transientContinuationAttempted = false/);
    expect(src).toMatch(/runPiContinuationRecovery/);
    expect(src).toMatch(/trigger: 'transient'/);
    expect(src).toMatch(/runTransientContinuationOnce\('transient-retry-exhausted'\)/);
    expect(src).toMatch(/runTransientContinuationOnce\('prompt-rejected'\)/);
    expect(src).toMatch(/const recoveryDecision = decidePiContinuationRecovery\(recoveryState\)/);
    expect(src).toMatch(/transient retry primitive:/);
    expect(src).toMatch(/recoveryDecision\.action === 'native_continue'/);
    expect(src).toMatch(/recoveryDecision\.action === 'recovery_prompt'/);
    expect(src).not.toMatch(/else \{\s*await continueWithPiNativeLifecycle\('transient retry after started work'\);\s*\}/);

    const typesSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../types.ts'), 'utf-8'
    );
    expect(typesSrc).toMatch(/retryable\?: boolean/);

    const wsHandlerSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf-8'
    );
    expect(wsHandlerSrc).toMatch(/retryable:\s*msg\.retryable/);
  });

  it('classifies assistant tool boundaries as incomplete without auto-prompting and keeps native continuation opt-in for other leaves', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const incompleteToolBoundaryContinuationEnabled = isIncompleteToolBoundaryContinuationEnabled\(\)/);
    expect(src).toMatch(/inspectPiRecoveryState\(entry\.session\)/);
    expect(src).toMatch(/trigger=incomplete_tool_boundary/);
    expect(src).toMatch(/recoveryState\.leafRole === 'assistant'/);
    expect(src).toMatch(/action=\$\{recoveryState\.leafRole === 'assistant' \? 'classify_incomplete'/);
    expect(src).toMatch(/if \(recoveryState\.leafRole === 'assistant'\) return false/);
    expect(src).not.toMatch(/TOOL_BOUNDARY_FINALIZATION_PROMPT/);
    const incompleteStart = src.indexOf('const runIncompleteTurnContinuationOnce = async');
    const incompleteEnd = src.indexOf("const promptPromise = (async () =>", incompleteStart);
    const incompleteBlock = src.slice(incompleteStart, incompleteEnd);
    expect(incompleteBlock).not.toMatch(/execute: \(\) => promptWithFetchCorrelation/);
    expect(src).toMatch(/if \(!incompleteToolBoundaryContinuationEnabled\) return false/);
    expect(src).toMatch(/runIncompleteTurnContinuationOnce\('prompt-resolved-incomplete'\)/);
    expect(src).toMatch(/refusing completed outcome for incomplete tool boundary/);
    expect(src).toMatch(/durableOutcome = 'retryable_failure'/);
    expect(src).not.toMatch(/makeIncompleteTurnContinuationPrompt/);
  });

  it('does not schedule durable retries when Pi native continuation cannot resume the transcript', () => {
    const src = readSource(PI_ENGINE_PATH);
    const adapterSrc = readSource(path.resolve(import.meta.dirname, '../pi/recovery/native-continuation-adapter.ts'));
    expect(src).toMatch(/isPiNativeContinuationUnavailable/);
    expect(src).toMatch(/const settleNativeContinuationUnavailable = async \(message: string\) =>/);
    expect(src).toMatch(/await completeRecoveryClaim\('uncertain', message\)/);
    expect(src).toMatch(/settlePiRecoveryOutcome\(\{/);
    expect(src).toMatch(/isUnavailable: isPiNativeContinuationUnavailable/);
    expect(adapterSrc).toMatch(/export function isPiNativeContinuationUnavailable/);
  });

  it('selects recovery primitives before transient and post-compact continuation', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/trigger=transient[\s\S]{0,260}action=\$\{recoveryDecision\.action\}/);
    expect(src).toMatch(/recoveryDecision\.action === 'recovery_prompt'[\s\S]{0,220}promptWithFetchCorrelation\(TRANSIENT_INTERRUPTION_RECOVERY_PROMPT\)/);
    expect(src).toMatch(/SERVER_RESTART_RECOVERY_PROMPT/);
    expect(src).not.toMatch(/AUTO_RESUME_ASSISTANT_LEAF_PROMPT/);
    expect(src).toMatch(/trigger=post_compact[\s\S]{0,260}action=\$\{recoveryDecision\.action\}/);
    expect(src).toMatch(/if \(recoveryDecision\.action !== 'native_continue'\) return false/);
    expect(src).toMatch(/execute: params\.execute \|\| continueWithPiNativeLifecycle/);
  });

  it('keeps oversized-preflight recovery off direct Pi native continuation', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/clearSuccessfulOversizedRecoveryIfPossible/);
    expect(src).toMatch(/hasDurableFinalAssistantText/);
    expect(src).toMatch(/stopReason !== 'stop'/);
    expect(src).toMatch(/allowNoopWithoutCompaction/);
    expect(src).not.toMatch(/source\.includes\('noop'\)/);
    expect(src).toMatch(/runPostCompactContinuationOnce\('oversized-preflight-post-compact'\)/);
    expect(src).toMatch(/runPostCompactContinuationOnce\('oversized-preflight-noop', \{ requireCompaction: false \}\)/);
    expect(src).toMatch(/현재 transcript 형태에서는 자동 이어가기가 안전하지 않아 중단/);
    expect(src).not.toMatch(/continueWithPiNativeLifecycle\('oversized-preflight-post-compact'\)/);
    expect(src).not.toMatch(/continueWithPiNativeLifecycle\('oversized-preflight-noop'\)/);
  });

  it('routes continuation triggers through the common recovery coordinator', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const runContinuationRecovery = async/);
    expect(src).toMatch(/runPiContinuationRecovery\(\{/);
    expect(src.match(/return runContinuationRecovery\(\{/g)).toHaveLength(3);
    expect(src).toMatch(/trigger: 'post_compact'/);
    expect(src).toMatch(/trigger: 'transient'/);
    expect(src).toMatch(/trigger: 'incomplete'/);
  });

  it('keeps Pi private continuation lifecycle isolated in the recovery adapter', () => {
    const src = readSource(PI_ENGINE_PATH);
    const adapterSrc = readSource(path.resolve(import.meta.dirname, '../pi/recovery/native-continuation-adapter.ts'));
    expect(src).toMatch(/continuePiNativeLifecycle\(entry!\.session, reason\)/);
    expect(src).not.toMatch(/_handlePostAgentRun|_emitAgentSettled|_isAgentRunActive|_flushPendingBashMessages/);
    expect(adapterSrc).toMatch(/sdkSession\._handlePostAgentRun/);
    expect(adapterSrc).toMatch(/sdkSession\._emitAgentSettled/);
    expect(adapterSrc).toMatch(/sdkSession\._isAgentRunActive/);
    expect(adapterSrc).toMatch(/sdkSession\._flushPendingBashMessages/);
  });

  it('keeps Pi-native continuation diagnostics out of the visible transcript', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const emitContinuationFailure = \(message: string\) =>/);
    expect(src).toMatch(/recoverable: nativeContinuationUnavailable/);
    expect(src).toMatch(/retryable: nativeContinuationUnavailable/);
    expect(src).toMatch(/emitFailure: emitContinuationFailure/);
    expect(src).toMatch(/runPiContinuationRecovery/);

    const wsHandlerSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf-8'
    );
    expect(wsHandlerSrc).toMatch(/if \(msg\.recoverable\) \{[\s\S]{0,160}type: 'resume_failed'/);

    const chatRuntimeSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../frontend/src/hooks/useChatRuntime.ts'), 'utf-8'
    );
    expect(chatRuntimeSrc).toMatch(/case 'resume_failed': \{[\s\S]{0,360}Keep provider detail in backend\/activity logs rather than user UI/);
  });


  it('refreshes completion telemetry from accumulator-backed visible content', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const \{ contentToSave \} = analysis\.assistantContent/);
    expect(src).toMatch(/if \(contentToSave\.length > 0\) \{[\s\S]{0,220}summarizeAssistantContinuationIntent\(\{[\s\S]{0,120}content: contentToSave/);
    expect(src).not.toMatch(/if \(analysis\.assistantContent\.finalContent\.length > 0\) \{[\s\S]{0,220}summarizeAssistantContinuationIntent/);
  });

  it('cancels a delayed transient retry when the same SDK run makes newer progress', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/if \(msgStopReason !== 'error' && transientAbortRetryRequested\)/);
    expect(src).toMatch(/cancelling stale transient retry after newer assistant progress/);
    expect(src).toMatch(/transientAbortRetryRequested = false;[\s\S]{0,100}transientAbortRetryMessage = '';[\s\S]{0,100}providerErrorMustRemainError = false/);
  });

  it('keeps recoverable transient notices and user stops out of durable assistant content, persisting only terminal exhaustion', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const persistTerminalTransientNotice = \(noticeText: string\) =>/);
    expect(src).toMatch(/Recoverable[\s\S]{0,180}runtime state, not assistant prose/);
    expect(src).toMatch(/persistTerminalTransientNotice\(noticeText\)/);
    expect(src).toMatch(/if \(entry\.abortRequested\) \{[\s\S]{0,360}return;/);
    expect(src).toMatch(/authoritative turn_terminal[\s\S]{0,160}neutral chat status box/);
    expect(src).not.toMatch(/persistTransientNotice/);
    expect(src).not.toMatch(/shouldPersistTransientNotice/);
    const importBlock = src.slice(
      src.indexOf("from './pi/transient-notice.js';") - 360,
      src.indexOf("from './pi/transient-notice.js';"),
    );
    expect(importBlock).not.toContain('PROVIDER_CAPACITY_NOTICE_TEXT,');
    expect(importBlock).not.toContain('TRANSIENT_ABORT_NOTICE_TEXT,');
    const suppressStart = src.indexOf('const suppressTransientAbortVisibleError =');
    const suppressEnd = src.indexOf('// DB callbacks are async', suppressStart);
    const suppressBlock = src.slice(suppressStart, suppressEnd);
    expect(suppressBlock).not.toMatch(/saveMessage|updateMessageContent|queueAssistantEvent/);
  });
});

// ──────────────────────────────────────────────────────────────────
// OpenRouter context-compression safeguard — 2026-05-18
// Provider-side last-resort for prompt+tool+output > endpoint cap. Pi's
// turn-boundary auto-compaction can't catch a single oversized next
// request; this plugin offloads compression to OpenRouter. Aborted
// session ea0d8649 hit the exact failure mode this wiring prevents.
// ──────────────────────────────────────────────────────────────────

describe('Pi OpenRouter context-compression safeguard', () => {
  it('defines ensureOpenRouterContextCompressionPlugin', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/function ensureOpenRouterContextCompressionPlugin/);
    expect(src).toMatch(/plugins.*context-compression/s);
  });

  it('honors PI_OPENROUTER_CONTEXT_COMPRESSION=0 opt-out', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/PI_OPENROUTER_CONTEXT_COMPRESSION === '0'/);
  });

  it('wires compression alongside output clamp on the same bodyObj', () => {
    const src = readSource(PI_ENGINE_PATH);
    // Both safeguards must run on the same parsed body and share a single
    // re-serialize step — otherwise compression silently never reaches
    // OpenRouter.
    expect(src).toMatch(/clampChatCompletionsOutputTokens\(bodyObj\)[\s\S]{0,300}ensureOpenRouterContextCompressionPlugin\(bodyObj\)/);
    expect(src).toMatch(/clamp\.mutated\s*\|\|\s*compression\.mutated/);
    expect(src).toMatch(/openrouter context-compression:/);
  });

  it('flips enabled=false back on (provider-side re-enable safety)', () => {
    const src = readSource(PI_ENGINE_PATH);
    // If a previous interceptor (or upstream model code) inserted the plugin
    // with enabled=false, we re-enable rather than appending a duplicate.
    expect(src).toMatch(/existing\.enabled === false[\s\S]{0,80}existing\.enabled = true/);
  });
});

// ──────────────────────────────────────────────────────────────────
// Cache instrumentation parity with claude-engine — 2026-05-18
// Pi SDK normalizes per-provider cache fields into usage.cacheRead /
// usage.cacheWrite. Before this work pi-engine dropped them on the floor,
// leaving every Pi turn looking 0%-cached in DB even though Azure/Codex/
// OpenRouter Kimi all cache automatically.
// ──────────────────────────────────────────────────────────────────

describe('Pi usage instrumentation', () => {
  it('declares cumulative + per-iteration cache and cost counters', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/let cumulativeCacheRead\s*=\s*0/);
    expect(src).toMatch(/let cumulativeCacheWrite\s*=\s*0/);
    expect(src).toMatch(/let lastIterationCacheRead\s*=\s*0/);
    expect(src).toMatch(/let lastIterationCacheWrite\s*=\s*0/);
    expect(src).toMatch(/let cumulativeCostUsd\s*=\s*0/);
    expect(src).toMatch(/let lastCostUsd:\s*number \| undefined/);
  });

  it('captures usage.cacheRead / usage.cacheWrite / usage.cost from each message_end', () => {
    const src = readSource(PI_ENGINE_PATH);
    expect(src).toMatch(/const usageDelta = runCtx\.recordUsage\(usage\)/);
    expect(src).toMatch(/iterCacheRead\s*=\s*usageDelta\.cacheRead/);
    expect(src).toMatch(/iterCacheWrite\s*=\s*usageDelta\.cacheWrite/);
    expect(src).toMatch(/iterCostUsd\s*=\s*usageDelta\.costUsd/);
    expect(src).toMatch(/cumulativeCacheRead\s*=\s*runCtx\.cumulativeCacheRead/);
    expect(src).toMatch(/cumulativeCacheWrite\s*=\s*runCtx\.cumulativeCacheWrite/);
    expect(src).toMatch(/cumulativeCostUsd\s*=\s*runCtx\.cumulativeCostUsd/);
  });

  it('forwards per-iteration usage to updateMessageMetrics', () => {
    const src = readSource(PI_ENGINE_PATH);
    // The per-iteration metric block (the assistantSaved branch) must include
    // cache + cost fields. Match the block payload as a single chunk to assert
    // they are wired together with input/output.
    const block = src.match(/if \(assistantSaved && usage\) \{[\s\S]*?updateMessageMetrics\(msgId,\s*\{[\s\S]*?\}\);\s*\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/cacheReadTokens:\s*lastIterationCacheRead/);
    expect(block![0]).toMatch(/cacheCreationTokens:\s*lastIterationCacheWrite/);
    expect(block![0]).toMatch(/costUsd:\s*lastCostUsd/);
  });

  it('includes cumulative cache and cost totals in turn_done usage', () => {
    const src = readSource(PI_ENGINE_PATH);
    // emitTurnDone's usage object must carry cumulative totals so the
    // frontend / cost reports match claude-engine's contract.
    const block = src.match(/emitTurnDone\s*=\s*[\s\S]*?usage:\s*runCtx\.usageSummary\(\{[\s\S]*?\}\)/);
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/durationMs/);
    expect(block![0]).toMatch(/stopReason:\s*userFacingStopReason/);
    expect(block![0]).toMatch(/contextInputTokens/);
  });

  it('message-store persists provider cost in metadata.usage.cost_usd', () => {
    const src = readSource(MESSAGE_STORE_PATH);
    expect(src).toMatch(/cost_usd\?:\s*number/);
    expect(src).toMatch(/'cost_usd',\s*\$(8|9)::numeric/);
    expect(src).toMatch(/cacheRead !== null \|\| cacheCreation !== null[\s\S]*costUsd !== null/);
  });

  it('message-store preserves a valid terminal context snapshot when later iteration metrics omit it', () => {
    const src = readSource(MESSAGE_STORE_PATH);
    expect(src).toMatch(/WHEN \$15::jsonb IS NOT NULL THEN jsonb_build_object\('context_snapshot', \$15::jsonb\)/);
    expect(src).toMatch(/ELSE '\{\}'::jsonb/);
  });
});
