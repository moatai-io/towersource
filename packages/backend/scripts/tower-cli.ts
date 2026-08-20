#!/usr/bin/env tsx
/**
 * Owns: User-facing `tower` client CLI for remote Tower instances.
 * Public API: `tower auth/projects/files/tasks ...` over HTTP only.
 * See README.md in services/tower-cli and decision 2026-07-06-tower-cli-remote-client-boundary.md.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TOWER_URL = process.env.TOWER_URL || 'http://127.0.0.1:32355';
const CONFIG_DIR = path.join(os.homedir(), '.tower');
const CONFIG_PATH = path.join(CONFIG_DIR, 'cli.json');

type OutputFormat = 'json' | 'text';

type ParsedArgs = {
  command: string[];
  flags: Map<string, string | boolean>;
  positionals: string[];
};

type CliConfig = {
  url?: string;
  token?: string;
  user?: unknown;
  savedAt?: string;
};

type ProjectSummary = {
  id: string;
  name: string;
  rootPath?: string;
  description?: string;
};

function printHelp(): void {
  console.log(`Tower CLI

Usage:
  tower auth login --username <name> [--url <url>]
  tower auth token import [--url <url>] [--token <tower-cli-token> | stdin]
  tower auth status [--url <url>]
  tower projects list
  tower files list --project <id> [path]
  tower files read --project <id> <path>
  tower files write --project <id> <path> (--content <text> | --content-file <file> | stdin) [--confirm]
  tower tasks list [--project <id>]
  tower tasks create --project <id> --title <title> [--description <text>] [--prompt <text>]

Global flags:
  --url <url>     Tower instance URL (default: TOWER_URL or ${DEFAULT_TOWER_URL})
  --json          Emit machine-readable JSON
  --token <jwt>   Use a token without reading ~/.tower/cli.json

Safety:
  This is a remote client. It talks to Tower over HTTP and never requires DATABASE_URL.
  auth login prompts for a hidden password in an interactive terminal.
  CI/automation should import a scoped tower-cli token, not pass account passwords.
  files write is dry-run unless --confirm is passed.
  file paths are resolved by the Tower server inside the selected project root.
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals.slice(0, 2), flags, positionals: positionals.slice(2) };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true' || args.flags.get(name) === '1';
}

function output(value: unknown, format: OutputFormat): void {
  if (format === 'json') {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string, code = 1): never {
  console.error(`tower: ${message}`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read a password from an interactive TTY without echoing typed characters.
 * Non-interactive automation should use `tower auth token import` instead.
 */
export async function readPasswordFromTty(prompt = 'Password: '): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return '';

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  let password = '';

  stdout.write(prompt);
  stdin.resume();
  stdin.setEncoding('utf8');
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      stdout.write('\n');
    };

    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        const code = char.charCodeAt(0);
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(password);
          return;
        }
        if (code === 3) {
          cleanup();
          reject(new Error('password prompt cancelled'));
          return;
        }
        if (code === 4) {
          cleanup();
          resolve(password);
          return;
        }
        if (code === 8 || code === 127) {
          password = password.slice(0, -1);
          continue;
        }
        if (code < 32) continue;
        password += char;
      }
    };

    stdin.on('data', onData);
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readCliTokenFromInput(args: ParsedArgs): Promise<string> {
  const token = flag(args, 'token');
  if (token) return token.trim();
  return (await readStdin()).trim();
}

async function readConfig(): Promise<CliConfig> {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: CliConfig): Promise<void> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw || DEFAULT_TOWER_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) fail(`invalid --url: ${value}`);
  return value;
}

async function resolveBaseUrl(args: ParsedArgs): Promise<string> {
  const explicit = flag(args, 'url');
  if (explicit) return normalizeBaseUrl(explicit);
  const config = await readConfig();
  return normalizeBaseUrl(config.url || DEFAULT_TOWER_URL);
}

async function resolveToken(args: ParsedArgs): Promise<string> {
  const explicit = flag(args, 'token');
  if (explicit) return explicit;
  const config = await readConfig();
  if (!config.token) fail('not logged in. Run: tower auth login --username <name> --url <url>');
  return config.token;
}

function apiUrl(baseUrl: string, apiPath: string, query?: Record<string, string | undefined>): string {
  const url = new URL(`/api${apiPath}`, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function requestJson<T>(baseUrl: string, apiPath: string, opts: {
  method?: string;
  token?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
} = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(apiUrl(baseUrl, apiPath, opts.query), {
      method: opts.method || (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  if (!response.ok) {
    const message = parsed?.error || parsed?.message || response.statusText || `HTTP ${response.status}`;
    fail(message);
  }
  return parsed as T;
}

function remoteJoin(rootPath: string, input: string | undefined): string {
  const raw = input || '.';
  if (raw.startsWith('/')) return raw;
  const root = rootPath.replace(/\/+$/, '');
  if (raw === '.' || raw === '') return root;
  const clean = raw.replace(/^\.\/+/, '').replace(/^\/+/, '');
  return `${root}/${clean}`;
}

async function requireProject(args: ParsedArgs, baseUrl: string, token: string): Promise<ProjectSummary> {
  const projectId = flag(args, 'project');
  if (!projectId) fail('missing --project <id>');
  const projects = await requestJson<ProjectSummary[]>(baseUrl, '/projects', { token });
  const project = projects.find((p) => p.id === projectId || p.name === projectId);
  if (!project) fail(`project not found or inaccessible: ${projectId}`);
  if (!project.rootPath) fail(`project has no rootPath: ${projectId}`);
  return project;
}

async function handleAuth(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const baseUrl = await resolveBaseUrl(args);

  if (sub === 'status') {
    const config = await readConfig();
    const token = flag(args, 'token') || config.token;
    if (!token) {
      output({ authenticated: false, url: baseUrl, configPath: CONFIG_PATH }, format);
      return;
    }
    try {
      const user = await requestJson<unknown>(baseUrl, '/me', { token });
      output({ authenticated: true, url: baseUrl, user, configPath: CONFIG_PATH }, format);
    } catch {
      output({ authenticated: false, url: baseUrl, configPath: CONFIG_PATH }, format);
    }
    return;
  }

  if (sub === 'login') {
    const username = flag(args, 'username');
    if (!username) fail('auth login requires --username');
    if (flag(args, 'password') || process.env.TOWER_CLI_PASSWORD || !process.stdin.isTTY) {
      fail('auth login prompts for a hidden password on a TTY. For automation, import a scoped tower-cli token with: tower auth token import');
    }
    const password = await readPasswordFromTty();
    if (!password) fail('auth login requires an interactive password');
    const result = await requestJson<{ token: string; user: unknown }>(baseUrl, '/auth/cli-login', {
      method: 'POST',
      body: { username, password },
    });
    await writeConfig({ url: baseUrl, token: result.token, user: result.user, savedAt: new Date().toISOString() });
    output({ ok: true, url: baseUrl, user: result.user, configPath: CONFIG_PATH }, format);
    return;
  }

  if (sub === 'token' && args.positionals[0] === 'import') {
    const rawToken = await readCliTokenFromInput(args);
    if (!rawToken) fail('auth token import requires --token <tower-cli-token> or token on stdin');
    const decoded = decodeJwtPayload(rawToken);
    if (decoded?.aud !== 'tower-cli') fail('auth token import requires a scoped tower-cli token');
    const user = await requestJson<unknown>(baseUrl, '/me', { token: rawToken });
    await writeConfig({ url: baseUrl, token: rawToken, user, savedAt: new Date().toISOString() });
    output({ ok: true, url: baseUrl, user, configPath: CONFIG_PATH }, format);
    return;
  }

  fail('unknown auth command. Use: tower auth login/status/token import');
}

async function handleProjects(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const baseUrl = await resolveBaseUrl(args);
  const token = await resolveToken(args);
  if (sub === 'list') {
    const projects = await requestJson<ProjectSummary[]>(baseUrl, '/projects', { token });
    output(projects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath, description: p.description || '' })), format);
    return;
  }
  fail('unknown projects command. Use: tower projects list');
}

async function handleFiles(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const baseUrl = await resolveBaseUrl(args);
  const token = await resolveToken(args);
  const project = await requireProject(args, baseUrl, token);

  if (sub === 'list') {
    const targetPath = remoteJoin(project.rootPath!, args.positionals[0]);
    const result = await requestJson<unknown>(baseUrl, '/files/tree', {
      token,
      query: { path: targetPath, showHidden: boolFlag(args, 'hidden') ? '1' : undefined },
    });
    output(result, format);
    return;
  }

  if (sub === 'read') {
    const targetPath = remoteJoin(project.rootPath!, args.positionals[0]);
    const result = await requestJson<unknown>(baseUrl, '/files/read', { token, query: { path: targetPath } });
    output(result, format);
    return;
  }

  if (sub === 'write') {
    const targetPath = remoteJoin(project.rootPath!, args.positionals[0]);
    const contentFlag = flag(args, 'content');
    const contentFile = flag(args, 'content-file');
    let content = contentFlag ?? '';
    if (contentFile) content = await fsp.readFile(path.resolve(contentFile.replace(/^~(?=\/|$)/, os.homedir())), 'utf8');
    if (contentFlag === undefined && !contentFile) content = await readStdin();
    if (content === '') fail('files write requires --content, --content-file, or stdin content');

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (!boolFlag(args, 'confirm')) {
      output({ ok: false, dryRun: true, requiresConfirm: true, path: targetPath, bytes: byteLength }, format);
      return;
    }

    const result = await requestJson<unknown>(baseUrl, '/files/write', {
      method: 'POST',
      token,
      body: { path: targetPath, content },
    });
    output({ ...(result as object), bytes: byteLength }, format);
    return;
  }

  fail('unknown files command. Use: tower files list/read/write');
}

async function handleTasks(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const baseUrl = await resolveBaseUrl(args);
  const token = await resolveToken(args);
  const projectId = flag(args, 'project');

  if (sub === 'list') {
    const tasks = await requestJson<any[]>(baseUrl, '/tasks', { token });
    output(projectId ? tasks.filter((t) => t.projectId === projectId || t.project_id === projectId) : tasks, format);
    return;
  }

  if (sub === 'create') {
    const title = flag(args, 'title');
    if (!title) fail('tasks create requires --title');
    const project = await requireProject(args, baseUrl, token);
    const prompt = flag(args, 'prompt') || flag(args, 'description') || title;
    const description = flag(args, 'description') || prompt;
    const task = await requestJson<unknown>(baseUrl, '/tasks', {
      method: 'POST',
      token,
      body: { title, description, cwd: project.rootPath, projectId: project.id, workflow: 'auto', reportPolicy: 'silent', prompt },
    });
    output({ ok: true, task }, format);
    return;
  }

  fail('unknown tasks command. Use: tower tasks list/create');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const format: OutputFormat = boolFlag(args, 'json') ? 'json' : 'text';
  const top = args.command[0];
  if (!top || boolFlag(args, 'help') || top === 'help') {
    printHelp();
    return;
  }

  if (top === 'auth') return handleAuth(args, format);
  if (top === 'projects') return handleProjects(args, format);
  if (top === 'files') return handleFiles(args, format);
  if (top === 'tasks') return handleTasks(args, format);
  fail(`unknown command: ${top}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
