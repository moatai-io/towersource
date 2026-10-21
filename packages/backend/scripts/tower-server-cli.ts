#!/usr/bin/env tsx
/**
 * Owns: Server-internal Tower CLI helper for host-side maintenance/debugging.
 * Public API: none. Use `packages/backend/scripts/tower-cli.ts` for the user-facing remote client.
 * This script may import backend services and require DATABASE_URL.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authenticateUser, generateScopedToken, verifyToken, type JwtPayload } from '../services/auth/auth.js';
import { getProject, getProjects } from '../services/pm/project-manager.js';
import { isPathAccessible, isPathWritableByRole, isDotfileDenied } from '../services/pm/project-access.js';
import { getFileTreeAsync, readFile, writeFile, expandHome } from '../services/workspace/file-system.js';
import { getAutomations, createAutomation } from '../services/task/automation-manager.js';
import { canCreateAutomationJob } from '../services/task/schedule-permissions.js';
import { queryOne } from '../db/pg-repo.js';

type OutputFormat = 'json' | 'text';

type ParsedArgs = {
  command: string[];
  flags: Map<string, string | boolean>;
  positionals: string[];
};

const CONFIG_DIR = path.join(os.homedir(), '.tower');
const CONFIG_PATH = path.join(CONFIG_DIR, 'cli.json');

function printHelp(): void {
  console.log(`Tower server-internal CLI

Usage:
  tower auth login --username <name>
  tower auth token import (--token <tower-cli-token> | stdin)
  tower auth status
  tower projects list
  tower files list --project <id> [path]
  tower files read --project <id> <path>
  tower files write --project <id> <path> (--content <text> | --content-file <file> | stdin) [--confirm]
  tower tasks list [--project <id>]
  tower tasks create --project <id> --title <title> [--description <text>] [--prompt <text>]

Global flags:
  --json          Emit machine-readable JSON
  --token <jwt>   Use a token without reading ~/.tower/cli.json

Safety:
  auth login prompts for a hidden password in an interactive terminal.
  CI/automation should import a scoped tower-cli token, not pass account passwords.
  files write is dry-run unless --confirm is passed.
  file paths are resolved inside the selected project root unless absolute.
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
  if (typeof value === 'string') return value;
  return undefined;
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
 * Falls back to an empty string when no TTY is attached so callers can show a
 * deterministic non-interactive error instead of blocking automation.
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

async function readConfigToken(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

async function writeConfigToken(token: string, payload: JwtPayload): Promise<void> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ token, user: payload, savedAt: new Date().toISOString() }, null, 2) + '\n';
  await fsp.writeFile(CONFIG_PATH, body, { mode: 0o600 });
}

async function readCliTokenFromInput(args: ParsedArgs): Promise<string> {
  const token = flag(args, 'token');
  if (token) return token.trim();
  return (await readStdin()).trim();
}

async function requireActiveUser(payload: JwtPayload): Promise<JwtPayload> {
  const row = await queryOne<{ id: number; username: string; role: string; disabled: number | boolean; approval_status: string; auth_epoch: number }>(
    'SELECT id, username, role, disabled, approval_status, auth_epoch FROM users WHERE id = $1',
    [payload.userId],
  );
  if (!row || row.disabled === 1 || row.disabled === true || row.approval_status !== 'active'
      || Number(payload.authEpoch ?? 0) !== Number(row.auth_epoch)) fail('token user is inactive or token was revoked; run tower auth login again');
  return { userId: row.id, username: row.username, role: row.role, aud: payload.aud, authEpoch: Number(row.auth_epoch) };
}

async function verifyCliTokenForImport(rawToken: string): Promise<JwtPayload> {
  if (!rawToken) fail('auth token import requires --token <tower-cli-token> or token on stdin');
  const payload = verifyToken(rawToken);
  if (!payload) fail('auth token import received an invalid or expired token');
  if (payload.aud !== 'tower-cli') fail('auth token import requires a scoped tower-cli token');
  return requireActiveUser(payload);
}

async function requireUser(args: ParsedArgs): Promise<JwtPayload> {
  const rawToken = flag(args, 'token') || await readConfigToken();
  if (!rawToken) fail('not logged in. Run: tower auth login --username <name>');
  const payload = verifyToken(rawToken);
  if (!payload) fail('saved token is invalid or expired. Run: tower auth login again.');
  return requireActiveUser(payload);
}

async function readCurrentUser(args: ParsedArgs): Promise<JwtPayload | null> {
  const rawToken = flag(args, 'token') || await readConfigToken();
  if (!rawToken) return null;
  const payload = verifyToken(rawToken);
  if (!payload) return null;
  try {
    return await requireActiveUser(payload);
  } catch {
    return null;
  }
}

async function handleAuth(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  if (sub === 'status') {
    const payload = await readCurrentUser(args);
    if (!payload) {
      output({ authenticated: false, configPath: CONFIG_PATH }, format);
      return;
    }
    output({ authenticated: true, user: payload, configPath: CONFIG_PATH }, format);
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
    const result = await authenticateUser(username, password);
    if (!result.ok || !result.payload) fail(`login failed: ${result.reason || 'invalid_credentials'}`);
    // Scoped so a copied CLI token cannot be used as a broad browser/API token.
    // The local CLI verifies the same JWT directly and executes backend services in-process.
    const token = generateScopedToken(result.payload, { aud: 'tower-cli', expiresIn: '30d' });
    await writeConfigToken(token, { ...result.payload, aud: 'tower-cli' });
    output({ ok: true, user: result.payload, configPath: CONFIG_PATH }, format);
    return;
  }

  if (sub === 'token' && args.positionals[0] === 'import') {
    const rawToken = await readCliTokenFromInput(args);
    const payload = await verifyCliTokenForImport(rawToken);
    await writeConfigToken(rawToken, payload);
    output({ ok: true, user: payload, configPath: CONFIG_PATH }, format);
    return;
  }

  fail('unknown auth command. Use: tower auth login/status/token import');
}

async function handleProjects(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const user = await requireUser(args);
  if (sub === 'list') {
    const projects = await getProjects(user.userId, user.role);
    output(projects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath, description: p.description || '' })), format);
    return;
  }
  fail('unknown projects command. Use: tower projects list');
}

async function requireProjectRoot(projectId: string | undefined, user: JwtPayload): Promise<string> {
  if (!projectId) fail('missing --project <id>');
  const project = await getProject(projectId);
  if (!project?.rootPath) fail(`project not found or has no rootPath: ${projectId}`);
  if (!(await isPathAccessible(project.rootPath, user.userId, user.role))) {
    fail('access denied: not a member of the project');
  }
  return project.rootPath;
}

function resolveProjectPath(projectRoot: string, input: string | undefined): string {
  const raw = input || '.';
  const expanded = expandHome(raw);
  const resolved = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(projectRoot, expanded));
  const root = path.resolve(projectRoot);
  if (!(resolved === root || resolved.startsWith(root + path.sep))) {
    fail('path must stay inside the selected project root');
  }
  return resolved;
}

async function handleFiles(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const user = await requireUser(args);
  const projectRoot = await requireProjectRoot(flag(args, 'project'), user);

  if (sub === 'list') {
    const dirPath = resolveProjectPath(projectRoot, args.positionals[0]);
    if (isDotfileDenied(dirPath)) fail('access denied: system path');
    if (!(await isPathAccessible(dirPath, user.userId, user.role))) fail('access denied: project path');
    const entries = await getFileTreeAsync(dirPath, 2, { showHidden: boolFlag(args, 'hidden') });
    output({ path: dirPath, entries }, format);
    return;
  }

  if (sub === 'read') {
    const filePath = resolveProjectPath(projectRoot, args.positionals[0]);
    if (isDotfileDenied(filePath)) fail('access denied: system path');
    if (!(await isPathAccessible(filePath, user.userId, user.role))) fail('access denied: project path');
    output({ path: filePath, ...readFile(filePath) }, format);
    return;
  }

  if (sub === 'write') {
    const filePath = resolveProjectPath(projectRoot, args.positionals[0]);
    if (isDotfileDenied(filePath)) fail('access denied: system path');
    if (!(await isPathAccessible(path.dirname(filePath), user.userId, user.role))) fail('access denied: project path');
    if (!(await isPathWritableByRole(filePath, user.userId, user.role))) fail('access denied: this folder is read-only for your role');

    const contentFlag = flag(args, 'content');
    const contentFile = flag(args, 'content-file');
    let content = contentFlag ?? '';
    if (contentFile) content = await fsp.readFile(expandHome(contentFile), 'utf8');
    if (contentFlag === undefined && !contentFile) content = await readStdin();
    if (content === '') fail('files write requires --content, --content-file, or stdin content');

    const existed = fs.existsSync(filePath);
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (!boolFlag(args, 'confirm')) {
      output({ ok: false, dryRun: true, requiresConfirm: true, action: existed ? 'overwrite' : 'create', path: filePath, bytes: byteLength }, format);
      return;
    }

    writeFile(filePath, content);
    output({ ok: true, action: existed ? 'overwrite' : 'create', path: filePath, bytes: byteLength }, format);
    return;
  }

  fail('unknown files command. Use: tower files list/read/write');
}

async function handleTasks(args: ParsedArgs, format: OutputFormat): Promise<void> {
  const sub = args.command[1];
  const user = await requireUser(args);
  const projectId = flag(args, 'project');

  if (sub === 'list') {
    const tasks = await getAutomations(user.userId, user.role, projectId ? { projectId } : undefined);
    output(tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, triggerType: t.triggerType, projectId: t.projectId, cwd: t.cwd, createdAt: t.createdAt })), format);
    return;
  }

  if (sub === 'create') {
    const title = flag(args, 'title');
    if (!title) fail('tasks create requires --title');
    const projectRoot = await requireProjectRoot(projectId, user);
    const prompt = flag(args, 'prompt') || flag(args, 'description') || title;
    const description = flag(args, 'description') || '';
    const createAccess = await canCreateAutomationJob({
      userId: user.userId,
      role: user.role,
      projectId,
      jobType: 'ai_prompt',
      scopeType: projectId ? 'project' : 'personal',
      definitionJson: { prompt, source: 'tower-cli' },
    });
    if (!createAccess.allowed) fail(createAccess.message || 'forbidden');
    const task = await createAutomation({
      userId: user.userId,
      projectId,
      name: title,
      description,
      prompt,
      cwd: projectRoot,
      triggerType: 'manual',
      jobType: 'ai_prompt',
      scopeType: projectId ? 'project' : 'personal',
      definitionJson: { prompt, source: 'tower-cli' },
      mode: 'spawn',
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
