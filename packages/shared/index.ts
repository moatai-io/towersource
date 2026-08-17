/**
 * @tower/shared — Base types shared between frontend and backend.
 *
 * These are the API-boundary types: fields that cross HTTP/WebSocket.
 * Backend and frontend extend these with their own fields as needed.
 *
 * INVARIANT: This package has ZERO runtime dependencies.
 */

export * from './agent-career.js';

// ── Session ──────────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  /**
   * URL-friendly short code (8자 base32, 알파벳 31자) — raw UUID 노출을 줄이고 사람이
   * 기억·공유하기 쉽도록 추가된 별칭. `/s/<shortCode>` 가 권장 진입점, `/s/<id>` 도 영구
   * 수용(하위호환). 마이그레이션 067 적용 후 신규 세션은 항상 발급, 기존 세션은 부팅 시
   * backfill. NULL 가능 (backfill 직전·UPDATE 실패 시).
   * 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md (issue #11)
   */
  shortCode?: string;
  /** Legacy Claude-only resume id. New UI code should prefer engineSessionId. */
  claudeSessionId?: string;
  /**
   * Pi engine's per-session resume identifier — path to ~/.pi/sessions/<uuid>.jsonl.
   * Independent of claudeSessionId so a single session can carry both after a
   * hard engine switch (workspace/decisions/2026-05-19-engine-hard-switch-design.md).
   * NULL until Pi has run at least one turn in this session.
   */
  piSessionFile?: string;
  /** Engine-neutral resume identifier for the session's active engine. */
  engineSessionId?: string;
  name: string;
  cwd: string;
  tags: string[];
  favorite: boolean;
  totalCost: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
  modelUsed?: string;
  autoNamed?: number;
  summary?: string;
  summaryAtTurn?: number;
  turnCount?: number;
  /** Real user-initiated turns (messages with role='user' + type='text').
   *  Excludes tool_result bounces and intermediate assistant tool_use/thinking.
   *  Computed live by getSessions() via a LEFT JOIN over a partial index. */
  userTurnCount?: number;
  filesEdited?: string[];
  projectId?: string | null;
  engine?: string;
  visibility?: 'private' | 'project';
  roomId?: string | null;
  parentSessionId?: string | null;
  sourceMessageId?: string | null;
  ownerUsername?: string | null;
  /** Username of the latest real user text turn in this session, if known. */
  lastUserUsername?: string | null;
  label?: string | null;
  /** Present only for the first Session provisioned with a new Primary Agent. */
  agentCreationCommandId?: string | null;
  /** UI-only grouping hint when a session appears inside the right-side AI panel. */
  aiPanelScope?: 'channel' | 'session' | 'project';
  /** Agent metadata when this session is the backing session of an Agent worker. */
  agent?: {
    workerId: string;
    name: string;
    role?: string | null;
    visibility?: string | null;
    status?: string | null;
    kind?: string | null;
    hasHumanInput?: boolean;
  } | null;
  /**
   * Coarse classification for Mission Control (D16). Orthogonal to `label`:
   *   'user'           — created by a human or in response to one (default)
   *   'autonomous_run' — spawned by scheduler / proactive monitor / agent
   * See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
   */
  kind?: 'user' | 'autonomous_run' | 'deployment';
  /**
   * Pinned `CLAUDE_CONFIG_DIR` for this session — the directory under which
   * the SDK writes its turn-by-turn jsonl. Resolved at create time from the
   * session's project → claude_account → config_dir chain and stored on the
   * row so subsequent calls don't re-resolve (and don't drift if the
   * project's account is later reassigned).
   *
   * NULL = no pinned directory; callers fall back to runtime
   * `getConfigDir(projectId)` (which itself falls back to the default account,
   * then to undefined / `~/.claude/`).
   *
   * See: workspace/decisions/2026-05-09-multi-account-configdir-audit.md
   */
  configDir?: string | null;
  /**
   * Timestamp of the most recent server-side auto-resume after a restart.
   * Set by `serverSideResumeInterrupted()` (ws-handler.ts) when it injects
   * a hidden trigger message. Frontend reads this to render a small
   * "재시작 후 자동 재개됨" banner above the chat until the user types
   * their next message.
   *
   * NULL = never auto-resumed (or resumed before this column existed).
   *
   * See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
   * Migration: 055_messages_metadata.sql
   */
  lastAutoResumeAt?: string | null;
}

// ── Task ─────────────────────────────────────────────────────────

export type WorkflowMode = 'auto' | 'simple' | 'default' | 'feature' | 'big_task';

/**
 * How a task's completion is reported.
 *
 * - `silent`  — no external notification, just the kanban badge.
 *               (Default for new tasks created through the UI.)
 * - `channel` — post an `ai_summary` / `ai_error` message to `roomId`.
 * - `kakao`   — push via messageRouter (Kakao/Telegram).
 * - `all`     — both `channel` and `kakao`.
 * - `default` — legacy behaviour preserved for tasks created before the
 *               policy existed: post to room if `roomId` is set AND push
 *               to Kakao for every task owner. Do not use for new rows.
 *
 * See: workspace/decisions/2026-04-22-task-report-policy.md
 */
export type TaskReportPolicy = 'silent' | 'notification' | 'channel' | 'kakao' | 'all' | 'default';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TaskMeta {
  id: string;
  title: string;
  description: string;
  cwd: string;
  /**
   * Engine that runs this task. Default 'claude' for backward compat with
   * tasks created before column 058 existed. 'pi' routes through PiEngine
   * (OpenRouter / Azure). 'local' is reserved (LocalEngine).
   * See: workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md (W2)
   */
  engine: 'claude' | 'pi' | 'local';
  model: string;
  status: 'todo' | 'in_progress' | 'done' | 'failed';
  sessionId: string | null;
  sortOrder: number;
  progressSummary: string[];
  todoSnapshot: TodoItem[] | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  scheduledAt: string | null;
  scheduleCron: string | null;
  scheduleEnabled: boolean;
  workflow: WorkflowMode;
  parentTaskId: string | null;
  worktreePath: string | null;
  projectId: string | null;
  roomId: string | null;
  triggeredBy: number | null;
  roomMessageId: string | null;
  userId: number | null;
  creatorName: string | null;
  reportPolicy: TaskReportPolicy;
}

// ── Schedule ────────────────────────────────────────────────────

export interface ScheduleEntry {
  id: string;
  userId: number;
  projectId: string | null;
  name: string;
  prompt: string;
  model: string;
  mode: 'spawn' | 'inject' | 'channel';
  targetId: string | null;
  triggerType: 'cron' | 'once';
  cronConfig: ScheduleCronConfig | null;
  onceAt: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCronConfig {
  type: 'daily' | 'weekdays' | 'weekly' | 'interval';
  hour?: number;
  minute?: number;
  day?: number;
  hours?: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  status: string;
  mode: string;
  resultId: string | null;
  error: string | null;
  durationMs: number | null;
  ranAt: string;
}

// ── Automation ──────────────────────────────────────────────────

export type AutomationMode = 'spawn' | 'inject' | 'channel';
export type AutomationTrigger = 'manual' | 'cron' | 'once' | 'event';
export type AutomationStatus = 'idle' | 'running' | 'done' | 'failed' | 'archived';
export type AutomationJobType = 'ai_prompt' | 'webhook' | 'shell' | 'script' | 'monitor' | 'workbench_execution';
export type AutomationScopeType = 'project' | 'system' | 'personal';
export type AutomationRiskLevel = 'low' | 'medium' | 'high';
export type AutomationRunTrigger = 'schedule' | 'manual' | 'retry' | 'ai' | 'system';
export type AutomationRunnerKind = 'ai' | 'host' | 'runtime_box' | 'webhook' | 'system';

export interface Automation {
  id: string;
  userId: number;
  projectId: string | null;
  name: string;
  description: string;
  prompt: string;
  model: string;
  workflow: string;
  jobType: AutomationJobType;
  scopeType: AutomationScopeType;
  definitionJson: Record<string, unknown>;
  riskLevel: AutomationRiskLevel;
  timeoutSeconds: number | null;
  timezone: string;
  createdBySessionId: string | null;
  updatedByUserId: number | null;
  configUpdatedAt: string;
  configUpdatedByUserId: number | null;
  runtimeStateJson: Record<string, unknown>;
  mode: AutomationMode;
  targetId: string | null;
  cwd: string | null;
  triggerType: AutomationTrigger;
  cronConfig: AutomationCronConfig | null;
  onceAt: string | null;
  status: AutomationStatus;
  enabled: boolean;
  sortOrder: number;
  sessionId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  lastError: string | null;
  progressSummary: string[];
  todoSnapshot: TodoItem[] | null;
  parentId: string | null;
  worktreePath: string | null;
  roomId: string | null;
  triggeredBy: number | null;
  roomMessageId: string | null;
  creatorName: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AutomationCronConfig {
  type: 'daily' | 'weekdays' | 'weekly' | 'interval';
  hour?: number;
  minute?: number;
  day?: number;
  /** Interval schedules. Prefer minutes; hours is kept for older saved schedules. */
  minutes?: number;
  hours?: number;
}

export type {
  AutomationConditionEvaluation,
  AutomationYamlDraftOptions,
  AutomationYamlEditSuggestion,
  AutomationYamlMaterializedUpdates,
  AutomationYamlMaterializeResult,
  AutomationYamlIssue,
  AutomationYamlSeverity,
  AutomationYamlValidationResult,
} from './automation-yaml.js';
export { automationYamlDraft, evaluateAutomationConditionV1, materializeAutomationYamlV1, suggestAutomationYamlEditV1, validateAutomationYamlV1 } from './automation-yaml.js';

export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  mode: string;
  resultId: string | null;
  error: string | null;
  durationMs: number | null;
  ranAt: string;
  trigger: AutomationRunTrigger;
  startedAt: string | null;
  finishedAt: string | null;
  stdoutText: string | null;
  stderrText: string | null;
  summaryText: string | null;
  errorJson: Record<string, unknown> | null;
  runnerKind: AutomationRunnerKind | null;
  runnerRef: string | null;
}

export type ProcessEventSourceType = 'todowrite' | 'tool_call' | 'artifact' | 'automation_run' | 'agent_report' | 'command_invocation' | 'skill_invocation' | 'user_decision' | 'system';
export type ProcessEventType = 'step_started' | 'step_completed' | 'step_failed' | 'artifact_created' | 'approval_requested' | 'decision_made' | 'blocked' | 'unblocked';
export type ProcessNodeKind = 'user_intent' | 'data_input' | 'ai_step' | 'tool_step' | 'command' | 'skill' | 'human_review' | 'decision' | 'artifact' | 'blocker' | 'automation_candidate';
export type ProcessNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type ProcessOwner = 'ai' | 'human' | 'system' | 'external';
export type ProcessAutomationLevel = 'manual' | 'assisted' | 'semi_auto' | 'auto';
export type ProcessEdgeRelation = 'depends_on' | 'produces' | 'reviews' | 'triggers' | 'blocks' | 'summarizes';

export interface ProcessEvent {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  automationId: string | null;
  runId: string | null;
  sourceType: ProcessEventSourceType;
  sourceId: string | null;
  eventType: ProcessEventType;
  rawLabel: string | null;
  rawPayload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface ProcessNode {
  id: string;
  label: string;
  kind: ProcessNodeKind;
  status: ProcessNodeStatus;
  owner: ProcessOwner;
  automationLevel: ProcessAutomationLevel;
  summary?: string;
  evidence?: {
    eventIds?: string[];
    files?: string[];
    toolCalls?: string[];
    sessionIds?: string[];
    logs?: string[];
  };
}

export interface ProcessEdge {
  id: string;
  from: string;
  to: string;
  relation: ProcessEdgeRelation;
}

export interface ProcessMap {
  id: string;
  title: string;
  projectId: string | null;
  source: 'task' | 'schedule' | 'chat' | 'agent_run' | 'workflow';
  abstractionLevel: 'run' | 'workflow' | 'organization';
  status: 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'blocked';
  sourceRefs: Record<string, unknown>;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  nameKo: string;
  description: string;
  descriptionKo: string;
  icon: string;
  defaultTrigger: AutomationTrigger;
  defaultMode: AutomationMode;
  defaultCron?: AutomationCronConfig;
  promptTemplate: string;
  category: 'research' | 'development' | 'operations' | 'communication';
}

// ── Space ───────────────────────────────────────────────────────

export interface Space {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  type: 'client' | 'research' | 'internal' | 'personal' | 'custom';
  color: string;
  icon: string;
  sortOrder: number;
  archived: number;
  createdAt: string;
}

// ── Project ──────────────────────────────────────────────────────

export interface ProjectAgentProfile {
  /** Namespaced logical id. MVP: project:<projectId>. */
  id: string;
  kind: 'primary';
  projectId: string;
  displayName: string;
  face: string;
  tagline: string | null;
  role: string | null;
  promise: string | null;
  profileVersion: number;
  instructionSource: string;
  defaultEngine: string | null;
  defaultModel: string | null;
  authorityPolicy: Record<string, unknown>;
  toolPolicy: Record<string, unknown> & { disabledSkills?: string[] };
  memoryPolicy: Record<string, unknown>;
  budgetPolicy: Record<string, unknown>;
  status: string;
  onboardingState: string;
  careerLevel?: import('./agent-career.js').AgentCareerLevel;
  /** False when derived from the legacy Project row/AGENTS.md convention. */
  explicit: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  rootPath: string | null;
  color: string;
  sortOrder: number;
  collapsed: number;
  archived: number;
  lifecycleStatus?: 'active' | 'retiring' | 'retired' | 'purge_pending' | 'purge_failed';
  retiredAt?: string | null;
  retiredByUserId?: number | null;
  retirementReason?: string | null;
  createdAt: string;
  spaceId: number | null;
  spaceName?: string | null;
  spaceSlug?: string | null;
  claude_account_id?: string | null;
  /** Stable key for managed/system Projects such as the full-only AI talent team. */
  systemKey?: string | null;
  /** Current user's personal sidebar pin state. */
  pinned?: boolean;
  /** Current user's personal order within the pinned section. */
  pinOrder?: number | null;
  /** The Project's single Primary Agent Workcell identity. Present on current APIs; optional for older cached payloads. */
  agent?: ProjectAgentProfile;
}

// ── Pin ──────────────────────────────────────────────────────────

export interface Pin {
  id: number;
  title: string;
  file_path: string;
  file_type: string;
  sort_order: number;
  created_at: string;
}

// ── Prompt ────────────────────────────────────────────────────────

export interface PromptItem {
  id: number | string;
  title: string;
  content: string;
  source: 'user' | 'commands';
  readonly: boolean;
}

// ── File System ──────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
  extension?: string;
}

// ── Skill ────────────────────────────────────────────────────────

export type SkillScope = 'company' | 'project' | 'personal';

/** Phase B — audience tier (vertical permission ladder, library skills only) */
export type SkillTier = 'tower-admin' | 'workspace-admin' | 'team';

/**
 * Phase B (Option B, 2026-05-05) — owner identifier for multi-tenant skill ownership.
 * Free-form string referencing library.yaml `owners.<id>` registry entry.
 * Examples: 'moat' (Tower provider), 'demo-org' (tenant company), etc.
 * Currently metadata-only; deploy-time owner-aware policy is a follow-up decision.
 */
export type SkillOwner = string;

/**
 * Phase C (Sprint 1, 2026-05-20) — visibility/lifecycle/risk/data_policy/review metadata.
 * Decision: workspace/decisions/2026-05-20-skill-sharing-visibility-and-usage-tracking.md
 */

/**
 * Skill Registry visibility (2026-05-26):
 * private = owner only, public = searchable/copyable, default = prompt 후보, hidden = excluded.
 */
export type SkillVisibility = 'private' | 'public' | 'default' | 'hidden';

/** 성숙도 — draft(작성 중) / beta(테스트) / stable(안정) / deprecated(폐지 예정) / archived(완전 폐기) */
export type SkillLifecycle = 'draft' | 'beta' | 'stable' | 'deprecated' | 'archived';

/** 위험 등급 — low/medium/high */
export type SkillRiskLevel = 'low' | 'medium' | 'high';

export interface SkillRisk {
  level: SkillRiskLevel;
  /** 외부로 메시지·메일·요청 발송 (gws, slack, webhook 등) */
  canSendExternal: boolean;
  /** 디스크 파일 수정·삭제 */
  canModifyFiles: boolean;
  /** 서버·인프라 배포·재시작 (fleet, deploy, prod-restart) */
  canDeploy: boolean;
  /** API 키·토큰·자격증명 사용 */
  usesSecrets: boolean;
}

export interface SkillDataPolicy {
  /** 고객·사용자 PII / 업무 데이터 처리 */
  handlesCustomerData: boolean;
  /** 출력 저장 (워크스페이스·DB 영구화) */
  storesOutputs: boolean;
  /** 외부 API 호출 (OpenAI, Google, Slack 등) */
  externalApi: boolean;
}

export interface SkillReview {
  /** 마지막 리뷰어 username 또는 식별자 */
  reviewedBy?: string | null;
  /** ISO timestamp */
  reviewedAt?: string | null;
  /** 리뷰 메모·합의 사항 */
  notes?: string | null;
}

export interface SkillRequires {
  /** CLI command names this skill expects, e.g. gws, gh, wrangler. */
  cli?: string[];
  /** Python import names this skill expects, e.g. pandas, fitz, pytesseract. */
  python?: string[];
  /** Secret/env labels only — never values. */
  secrets?: string[];
  /** External network requirement. */
  network?: 'none' | 'optional' | 'required';
}

export type SkillRequirementKind = 'cli' | 'python' | 'secret' | 'network';
export type SkillRequirementStatus = 'ok' | 'missing' | 'credential-needed' | 'not-checked';

export interface SkillRequirementCheck {
  kind: SkillRequirementKind;
  name: string;
  required: boolean;
  status: SkillRequirementStatus;
  message?: string;
}

/** Abstract execution capability hints. Registry never names a concrete Tower runtime here. */
export interface SkillRuntimeRequirements {
  execution?: 'none' | 'optional' | 'required';
  persistence?: 'none' | 'long_running_optional' | 'long_running_required';
  network?: 'none' | 'optional' | 'required';
  /** Logical secret labels only — never values. */
  secrets?: string[];
  /** Package/tool dependency hints, not installation instructions. */
  packages?: string[];
}

/** Portability metadata for warning users without coupling skills to Tower runtime details. */
export interface SkillPortability {
  level?: 'portable' | 'tower-ops-only' | 'environment-bound';
  warnings?: string[];
}

/**
 * Skill distribution/exposure metadata.
 * - audience gates prompt injection and slash command listing.
 * - profiles/customerSafe gate install/deploy to VMs.
 * Tags remain category/search labels and must not be used as policy.
 */
export interface SkillDistribution {
  /** Deprecated for prompt exposure. Kept only for legacy parsing. Prefer top-level `access`. */
  audience?: 'moat-internal' | 'operator' | 'customer-admin' | 'customer-user' | 'public';
  profiles?: Array<'standalone' | 'managed' | 'full' | string>;
  customerSafe?: boolean;
}

/** Minimal skill exposure ACL. Missing access means `['everyone']` for backward compatibility. */
export type SkillAccessGrant = 'everyone' | `user:${string}` | `group:${string}`;

export interface SkillMeta {
  id: string;
  name: string;
  scope: SkillScope;
  description: string;
  category: string;
  enabled: boolean;
  /** Per-user toggle (null = no pref set, defaults to enabled) */
  userEnabled?: boolean | null;
  source: 'bundled' | 'custom' | 'marketplace' | 'official' | 'library' | 'project-fs';
  skillPath?: string | null;
  projectId?: string | null;
  userId?: number | null;
  /** Author username (resolved from users.id JOIN; null for library/company scope) */
  createdByName?: string | null;
  /** Project name (resolved from projects JOIN; null for personal/company scope) */
  projectName?: string | null;
  /** Phase B — audience tier from library.yaml. Defaults to 'team' if absent. */
  tier?: SkillTier;
  /** Phase B (Option B) — owner identifier (org/team that owns this skill). */
  owner?: SkillOwner | null;
  /** Registry catalog source for filesystem skills. system = operator-managed, local = VM-local. */
  catalog?: 'system' | 'local' | null;
  /** Registry ownership bucket. Distinct from prompt injection or runtime capability. */
  ownership?: 'system' | 'vm-local' | 'personal' | 'project';
  /** Human-debuggable source origin. User surfaces translate this to Tower/team/project language. */
  origin?: 'tower' | 'org' | 'project' | string;
  /** Stable internal identity used for provenance and collision diagnostics. */
  canonicalId?: string;
  /** Deterministic digest of scanner-allowed bundle files. */
  bundleDigest?: string;
  /** Best-effort source Git commit. Missing outside a Git worktree. */
  sourceCommit?: string;
  /** Registry visibility. `public` is searchable/copyable but not prompt-default. */
  visibility?: SkillVisibility;
  /** Phase C — 성숙도. parser default: semver major < 1 → 'beta', else 'stable'. */
  lifecycle?: SkillLifecycle;
  /** Phase C — 위험 metadata. parser default: { level:'low', 4 false }. yaml override 만 명시. */
  risk?: SkillRisk;
  /** Phase C — 데이터 정책. parser default: 모두 false. */
  dataPolicy?: SkillDataPolicy;
  /** Phase C — 리뷰 메타. 미리뷰는 빈 객체 {}. */
  review?: SkillReview;
  /** Abstract runtime requirements. Does not choose sandbox/host/publishing. */
  runtimeRequirements?: SkillRuntimeRequirements;
  /** Portability warnings and level. */
  portability?: SkillPortability;
  /** Distribution/install policy. Not used for prompt injection. */
  distribution?: SkillDistribution;
  /** Who can see/search/call this skill. Missing means everyone. */
  access?: SkillAccessGrant[];
  createdAt: string;
  updatedAt: string;
  /** Recent skill invocation count, populated by the skill catalog API when available. */
  recentUsageCount?: number;
  /** Total skill invocation count, populated by the skill catalog API when available. */
  usageCount?: number;
  /** Last skill invocation timestamp, populated by the skill catalog API when available. */
  lastUsedAt?: string | null;
  /** Providers this skill requires (populated from skill_providers table) */
  providers?: SkillProvider[];
}

export interface SkillProvider {
  provider: string;       // 'google', 'kakao', 'slack', 'github', ...
  required: boolean;
  scopeHint: string;      // 'gmail.readonly gmail.send', etc.
}

export interface ConnectionStatus {
  provider: string;
  connected: boolean;
  nickname?: string | null;
  expiresAt?: number | null;   // Unix timestamp (ms)
}

export interface SkillReadiness {
  skillId: string;
  skillName: string;
  ready: boolean;
  missing: string[];     // providers not yet connected
  providers: Array<SkillProvider & { connected: boolean }>;
  /** Static SKILL.md frontmatter requirements. Parsed from `requires:` if present. */
  requires?: SkillRequires;
  /** Human-readable readiness notes for non-OAuth requirements. */
  requirementNotes?: string[];
  /** Per-requirement advisory checks. Phase 1 may return not-checked. */
  requirementChecks?: SkillRequirementCheck[];
}

// ── Git ──────────────────────────────────────────────────────────

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  message: string;
  commitType: 'auto' | 'manual' | 'rollback';
  filesChanged: string[];
  createdAt: string;
}

// ── Session Backlinks (Level 1) ──────────────────────────────────
// See: workspace/decisions/2026-04-21-session-backlinks-level1.md
//      workspace/decisions/2026-05-20-session-backlinks-cross-user.md (ACL 완화)

export interface RelatedSessionSharedFile {
  path: string;
}

export interface RelatedSessionResult {
  sessionId: string;
  name: string;
  score: number;
  sharedFiles: RelatedSessionSharedFile[];
  projectId: string | null;
  updatedAt: string;
  /** Owner of the candidate session (Tower users.id). Useful for "by X" UI. */
  userId: number | null;
  /** Owner's username (login). */
  username: string | null;
  /** Owner's display name (Korean / human-friendly); null → UI falls back to username. */
  displayName: string | null;
  /** True iff the candidate session's owner == caller. UI hides the byline in this case. */
  isMine: boolean;
}

export interface RelatedSessionsResponse {
  filesInSession: number;
  candidatesConsidered: number;
  queryMs: number;
  results: RelatedSessionResult[];
}

/**
 * One user-facing file the session has edited. Surfaced by
 * GET /api/sessions/:id/touched-files and rendered by the sidebar
 * "이 세션의 파일" panel.
 *
 * See: workspace/decisions/2026-05-20-session-scoped-file-tabs.md
 */
export interface TouchedFile {
  /** Absolute path. Used as the dedup key and the FileViewer load target. */
  path: string;
  /** Last edit tool ('Edit' | 'Write' | 'NotebookEdit' | 'unknown'). */
  toolName: string;
  /** ISO timestamp of the *most recent* edit (UPDATE ON CONFLICT refreshes this). */
  lastTouchedAt: string;
}

export interface TouchedFilesResponse {
  /** Most recent first. Capped at the requested limit (default 10). */
  files: TouchedFile[];
  queryMs: number;
}

// ── Project-scoped recent files (sidebar fallback) ──
// Used when the active session's own working set is empty.
// Decision: workspace/decisions/2026-05-22-sidebar-session-files-panel.md

/**
 * A file recently edited by *another* session in the same project.
 * The sessionId/sessionName fields drive the hover tooltip ("출처 세션").
 */
export interface ProjectRecentFile {
  /** Absolute path. Dedup key and FileViewer load target. */
  path: string;
  /** Last edit tool across all sessions that touched this file. */
  toolName: string;
  /** ISO timestamp of the most recent edit (any session in the project). */
  lastTouchedAt: string;
  /** UUID of the session that most recently touched this file. */
  sessionId: string;
  /** Display name of that session (for hover tooltip). */
  sessionName: string;
}

export interface ProjectRecentFilesResponse {
  /** Most recent first, capped at limit (default 20). Empty when projectMissing. */
  files: ProjectRecentFile[];
  /**
   * True when the active session has no project_id — caller should hide the
   * panel and show a "프로젝트를 지정해주세요" nudge instead.
   */
  projectMissing: boolean;
  queryMs: number;
}
