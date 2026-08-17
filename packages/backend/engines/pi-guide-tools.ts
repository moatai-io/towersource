/**
 * Pi guide resource tools — on-demand Tower guide resources for large prompt
 * sections that should not live permanently in the system prompt.
 *
 * Tool names intentionally use underscores, not dots. OpenAI Responses rejects
 * tool names outside ^[a-zA-Z0-9_-]+$.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type RuntimeGuideRole = 'guest' | 'viewer' | 'member' | 'operator' | 'admin';

export interface RuntimeGuideResource {
  name: string;
  title: string;
  description: string;
  relativePath: string;
  minRole: RuntimeGuideRole;
}

export interface RuntimeGuideToolContext {
  userRole?: string;
}

const ROLE_RANK: Record<RuntimeGuideRole, number> = {
  guest: 0,
  viewer: 1,
  member: 2,
  operator: 3,
  admin: 4,
};

const RUNTIME_GUIDES: RuntimeGuideResource[] = [
  {
    name: 'visualization',
    title: 'Tower Visualization Guide',
    description: 'Exact Tower visual block schemas, Mermaid rules, and JSON formatting constraints. Read before producing chart, mermaid, datatable, svg, html-sandbox, timeline, map, or other rich visual blocks.',
    relativePath: 'docs/tower-guide/resources/visualization.md',
    minRole: 'viewer',
  },
  {
    name: 'publishing',
    title: 'Tower Publishing Guide',
    description: 'Exact Tower static site publishing rules: publish_site flow, slug/visibility policy, URL patterns, thumbnail hints, verification, and external deploy exceptions.',
    relativePath: 'docs/tower-guide/resources/publishing.md',
    minRole: 'member',
  },
  {
    name: 'git',
    title: 'Tower Git / PR Guide',
    description: 'Exact Tower git, commit, PR, audit trailer, and multi-session safety procedures. Read before committing, pushing, creating PRs, or explaining Tower git workflow details.',
    relativePath: 'docs/tower-guide/resources/git.md',
    minRole: 'member',
  },
  {
    name: 'agent-orchestration',
    title: 'Tower Agent Orchestration Guide',
    description: 'Exact Tower subagent, persistent agent-worker, session spawn/send/readback/delete, quota, fan-in, and report-contract rules. Read before complex delegation or session orchestration.',
    relativePath: 'docs/tower-guide/resources/agent-orchestration.md',
    minRole: 'member',
  },
  {
    name: 'pdf-export',
    title: 'Tower PDF Export Guide',
    description: 'Exact Tower PDF export workflow: print-ready HTML rules, document vs image mode, preflight handling, verification loop, and PDF handoff expectations.',
    relativePath: 'docs/tower-guide/resources/pdf-export.md',
    minRole: 'member',
  },
  {
    name: 'pdf-analysis',
    title: 'Tower PDF Analysis Guide',
    description: 'Exact Tower PDF reading workflow: visual inspection, pdf_view vs pdf_read selection, table extraction, scanned/layout-heavy PDF handling, and Runtime Box boundaries.',
    relativePath: 'docs/tower-guide/resources/pdf-analysis.md',
    minRole: 'member',
  },
  {
    name: 'spreadsheet-analysis',
    title: 'Tower Spreadsheet Analysis Guide',
    description: 'Exact Tower Excel/CSV workflow: excel_read/query/diff/write usage, formatting semantics, formulas, Korean financial sheet patterns, and pandas query examples.',
    relativePath: 'docs/tower-guide/resources/spreadsheet-analysis.md',
    minRole: 'member',
  },
  {
    name: 'cad-analysis',
    title: 'Tower CAD Analysis Guide',
    description: 'Exact Tower CAD workflow: cad_view usage, DXF vs DWG renderer expectations, preview limitations, rendering options, and engineering sign-off caveats.',
    relativePath: 'docs/tower-guide/resources/cad-analysis.md',
    minRole: 'member',
  },
];

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

function findTowerRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(current, 'docs', 'tower-guide', 'resources'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolve a checked-in runtime guide from source or compiled `dist/` execution. */
export function resolveRuntimeGuideResourcePath(relativePath: string, startPaths?: string[]): string {
  const configuredRoot = process.env.TOWER_ROOT?.trim();
  const candidates = startPaths ?? [
    ...(configuredRoot ? [configuredRoot] : []),
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ];
  for (const candidate of candidates) {
    const root = findTowerRoot(candidate);
    if (root) return path.join(root, relativePath);
  }
  throw new Error(`Tower runtime guide root not found for ${relativePath}`);
}

function normalizeRole(role: string | undefined): RuntimeGuideRole {
  if (role === 'admin' || role === 'operator' || role === 'member' || role === 'viewer' || role === 'guest') return role;
  return 'member';
}

function canReadGuide(userRole: string | undefined, guide: RuntimeGuideResource): boolean {
  return ROLE_RANK[normalizeRole(userRole)] >= ROLE_RANK[guide.minRole];
}

function visibleGuides(ctx: RuntimeGuideToolContext): RuntimeGuideResource[] {
  return RUNTIME_GUIDES.filter((guide) => canReadGuide(ctx.userRole, guide));
}

function resolveGuidePath(resource: RuntimeGuideResource): string {
  return resolveRuntimeGuideResourcePath(resource.relativePath);
}

function summarizeGuide(resource: RuntimeGuideResource) {
  return {
    name: resource.name,
    title: resource.title,
    description: resource.description,
    minRole: resource.minRole,
  };
}

export function listRuntimeGuideResources(): RuntimeGuideResource[] {
  return [...RUNTIME_GUIDES];
}

export function createRuntimeGuideListTool(ctx: RuntimeGuideToolContext = {}): ToolDefinition {
  const name = 'runtime_guide_list';
  if (!TOOL_NAME_RE.test(name)) throw new Error(`Invalid Pi tool name: ${name}`);
  return ({
    name,
    label: 'List Tower Runtime Guides',
    description: 'List role-visible Tower runtime guide resources moved out of the core system prompt, without loading full guide bodies.',
    promptSnippet: 'Use runtime_guide_list to discover registered Tower runtime guides when exact product-specific instructions are needed.',
    promptGuidelines: [
      'Use runtime_guide_list when you need exact runtime guide names instead of guessing.',
      'Use runtime_guide_read to load the relevant registered guide body before relying on detailed schemas or procedures.',
      'This is a catalog reader, not an arbitrary file reader. Tool names use underscores; do not call dotted names such as runtime.guide.read.',
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Optional case-insensitive filter over guide name, title, and description.' })),
    }),
    execute: async (_toolCallId: string, input: { query?: string }) => {
      const q = input.query?.trim().toLocaleLowerCase();
      const available = visibleGuides(ctx);
      const guides = q
        ? available.filter((guide) => [guide.name, guide.title, guide.description]
            .some((value) => value.toLocaleLowerCase().includes(q)))
        : available;
      return textResult(JSON.stringify({ guides: guides.map(summarizeGuide), total: guides.length }, null, 2));
    },
  } as unknown as ToolDefinition);
}

export function createRuntimeGuideReadTool(ctx: RuntimeGuideToolContext = {}): ToolDefinition {
  const name = 'runtime_guide_read';
  if (!TOOL_NAME_RE.test(name)) throw new Error(`Invalid Pi tool name: ${name}`);
  return ({
    name,
    label: 'Read Tower Runtime Guide',
    description: 'Read one complete registered Tower runtime guide by name. Use this for detailed rules moved out of the system prompt.',
    promptSnippet: 'Use runtime_guide_read when you need exact Tower runtime guide details.',
    promptGuidelines: [
      'Use runtime_guide_read before producing detailed visual blocks, publishing-specific artifacts, or other guide-backed outputs once those guides exist.',
      'For visualization, call runtime_guide_read with name="visualization" before relying on exact schemas or Mermaid edge/label rules.',
      'For publishing, call runtime_guide_read with name="publishing" before relying on exact slug, visibility, URL, or verification rules.',
      'For git/PR work, call runtime_guide_read with name="git" before relying on exact commit message, Tower-Session trailer, or PR procedure details.',
      'For subagent or session orchestration work, call runtime_guide_read with name="agent-orchestration" before relying on exact quota, report, spawn, send, fan-in, or cleanup details.',
      'For PDF export work, call runtime_guide_read with name="pdf-export" before relying on exact print-ready HTML, mode, preflight, or verification-loop details.',
      'For existing PDF reading/table extraction, call runtime_guide_read with name="pdf-analysis" before relying on exact pdf_view/pdf_read flow details.',
      'For spreadsheet analysis, call runtime_guide_read with name="spreadsheet-analysis" before relying on exact excel_read/query/diff/write workflow details.',
      'For CAD/DXF/DWG inspection, call runtime_guide_read with name="cad-analysis" before relying on exact cad_view renderer and preview-limit rules.',
      'Do not invent guide names; use runtime_guide_list if unsure.',
    ],
    parameters: Type.Object({
      name: Type.String({ description: 'Guide resource name, e.g. visualization.' }),
    }),
    execute: async (_toolCallId: string, input: { name: string }) => {
      const requested = input.name.trim().toLocaleLowerCase();
      const guide = RUNTIME_GUIDES.find((candidate) => candidate.name.toLocaleLowerCase() === requested);
      if (!guide || !canReadGuide(ctx.userRole, guide)) return textResult(`Runtime guide not found or not visible in this session: ${input.name}`, true);
      try {
        const filePath = resolveGuidePath(guide);
        const content = fs.readFileSync(filePath, 'utf8');
        return textResult(JSON.stringify({ ...summarizeGuide(guide), content }, null, 2));
      } catch (err: any) {
        return textResult(`runtime_guide_read failed: ${err?.message || String(err)}`, true);
      }
    },
  } as unknown as ToolDefinition);
}
