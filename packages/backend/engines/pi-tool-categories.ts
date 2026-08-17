/**
 * pi-tool-categories.ts — coarse-grained Tower/Pi harness tool contracts.
 *
 * Owns: the taxonomy for harness tools. This is intentionally small and
 * intent-based, not extension-based, so the tool surface grows around stable
 * work contracts instead of one-off file-type hacks.
 *
 * See: workspace/decisions/2026-06-09-harness-tool-contract-categories.md
 */

export type PiToolCategory =
  | 'view'
  | 'analyze'
  | 'export'
  | 'runtime'
  | 'orchestrate'
  | 'integrate'
  | 'filesystem'
  | 'unknown';

export const PI_TOOL_CATEGORY_DESCRIPTIONS: Record<PiToolCategory, string> = {
  view: 'View/inspect existing artifacts the way a person would see them; visual fidelity matters.',
  analyze: 'Extract structure, data, tables, formulas, or searchable facts from artifacts.',
  export: 'Create final user-facing artifacts with a stable output contract.',
  runtime: 'Run project code, services, tests, scripts, or custom preprocessing.',
  orchestrate: 'Coordinate multi-step work, sub-agents, todos, or shared task queues.',
  integrate: 'Fetch or send data through external/web integrations.',
  filesystem: 'Read/search/edit/list ordinary workspace files.',
  unknown: 'Unclassified tool; should be reviewed before becoming a durable harness tool.',
};

const CATEGORY_BY_TOOL_NAME: Record<string, PiToolCategory> = {
  // Filesystem primitives
  read: 'filesystem',
  grep: 'filesystem',
  find: 'filesystem',
  ls: 'filesystem',
  edit: 'filesystem',
  write: 'filesystem',
  personal_note_append: 'filesystem',
  session_attachment_resolve: 'filesystem',
  session_attachment_save: 'filesystem',
  deliver_file: 'filesystem',
  deliver_directory: 'filesystem',

  // Runtime / project execution
  bash: 'runtime',
  project_shell: 'runtime',
  project_process: 'runtime',
  workbench_execute: 'runtime',
  service_list: 'runtime',
  service_start: 'runtime',
  service_stop: 'runtime',
  service_logs: 'runtime',

  // View — existing visual artifacts
  pdf_view: 'view',
  pdf_render: 'view',
  cad_view: 'view',

  // Analyze — structured extraction / computation
  excel_read: 'analyze',
  excel_query: 'analyze',
  excel_diff: 'analyze',
  pdf_read: 'analyze',
  conversation_search: 'analyze',
  memory_search: 'analyze',
  session_transcript_read: 'analyze',

  // Export — create final artifacts
  pdf_export: 'export',
  excel_write: 'export',
  publish_site: 'export',

  // Web / external integrations
  webfetch: 'integrate',
  websearch: 'integrate',
  mcp__sandbox__run: 'runtime',
  mcp__sandbox__tool_start: 'runtime',
  mcp__sandbox__tool_stop: 'runtime',
  mcp__sandbox__tool_restart: 'runtime',
  mcp__sandbox__tool_logs: 'runtime',
  mcp__sandbox__tool_list: 'runtime',
  mcp__sandbox__tool_update_visibility: 'runtime',

  // Orchestration
  agent: 'orchestrate',
  askuserquestion: 'orchestrate',
  todowrite: 'orchestrate',
  sharedtaskcreate: 'orchestrate',
  sharedtaskupdate: 'orchestrate',
  sharedtasklist: 'orchestrate',
  mcp__session_control__rename_current_session: 'orchestrate',
  mcp__schedule__create_ai_schedule: 'orchestrate',
  mcp__schedule__list_automations: 'orchestrate',
  mcp__schedule__get_automation: 'orchestrate',
  mcp__schedule__get_automation_runs: 'orchestrate',
  mcp__schedule__propose_automation_change: 'orchestrate',
  mcp__schedule__apply_automation_change: 'orchestrate',
  mcp__schedule__set_automation_enabled: 'orchestrate',
  mcp__schedule__run_automation_now: 'orchestrate',
  mcp__schedule__archive_automation: 'orchestrate',
  mcp__issue__file_issue: 'orchestrate',
  mcp__issue__get_issue: 'orchestrate',
  mcp__issue__comment_issue: 'orchestrate',
  mcp__tower_spawn__spawn_session: 'orchestrate',
  mcp__tower_spawn__send_to_session: 'orchestrate',
  mcp__tower_spawn__send_to_spawned_session: 'orchestrate',
  mcp__tower_spawn__get_spawned_response: 'orchestrate',
  mcp__tower_spawn__list_spawned_sessions: 'orchestrate',
  mcp__tower_spawn__delete_spawned_session: 'orchestrate',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[-.]/g, '_');
}

export function categorizePiTool(name: string | undefined | null): PiToolCategory {
  if (!name) return 'unknown';
  return CATEGORY_BY_TOOL_NAME[normalizeToolName(name)] ?? 'unknown';
}

export function formatPiToolCategorySummary(toolNames: string[]): string {
  const grouped = new Map<PiToolCategory, string[]>();
  for (const name of toolNames) {
    const category = categorizePiTool(name);
    const arr = grouped.get(category) ?? [];
    arr.push(name);
    grouped.set(category, arr);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, names]) => `${category}=${names.length}`)
    .join(', ');
}
