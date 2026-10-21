import path from 'node:path';
import { Type } from '@sinclair/typebox';
import type { EditOperations, FindOperations, LsOperations, ToolDefinition, WriteOperations } from '@earendil-works/pi-coding-agent';
import {
  compareAndSwapProjectWorkspaceText,
  createProjectWorkspaceDirectory,
  listProjectWorkspaceDirectory,
  projectWorkspaceEntryExists,
  readProjectWorkspaceFileBytes,
  resolveProjectWorkspaceFile,
  writeProjectWorkspaceText,
} from '../services/project-environment/project-workspace-files.js';
import { isPathAccessible, isPathWritableByRole } from '../services/pm/project-access.js';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules']);
const globMatcher = (pattern: string) => {
  const optionalPrefix = pattern.startsWith('**/') ? '(?:.*/)?' : '';
  const source = pattern.startsWith('**/') ? pattern.slice(3) : pattern;
  const escaped = source.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\\0/g, '.*');
  return new RegExp(`^${optionalPrefix}${escaped}$`);
};

export function createProjectQueryOperations(input: { projectId: string; projectRoot: string; actorUserId: number; actorRole?: string; signal?: AbortSignal }) {
  const root = path.resolve(input.projectRoot);
  const assertRead = async (absolutePath: string) => { if (input.actorRole && !await isPathAccessible(absolutePath, input.actorUserId, input.actorRole)) throw new Error('PROJECT_FILE_READ_ACCESS_REVOKED'); };
  const relative = (absolutePath: string, allowRoot = false) => {
    const target = path.resolve(absolutePath);
    if (target === root) {
      if (allowRoot) return '.';
      throw new Error('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    }
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    return path.relative(root, target).split(path.sep).join('/');
  };
  const reference = (absolutePath: string, allowRoot = false) => resolveProjectWorkspaceFile({
    projectId: input.projectId,
    projectRoot: root,
    relativePath: relative(absolutePath, allowRoot),
    allowProjectRoot: allowRoot,
  });
  const list = async (absolutePath: string) => {
    await assertRead(absolutePath);
    return listProjectWorkspaceDirectory({
      reference: await reference(absolutePath, true),
      actorUserId: input.actorUserId,
      depth: 1,
    });
  };
  const exists = async (absolutePath: string) => {
    try {
      await assertRead(absolutePath);
      if (path.resolve(absolutePath) === root) return (await projectWorkspaceEntryExists({ reference: await reference(root, true), actorUserId: input.actorUserId })).exists;
      return (await projectWorkspaceEntryExists({ reference: await reference(absolutePath), actorUserId: input.actorUserId })).exists;
    } catch (error: any) {
      if (/ENOENT|not found/i.test(error?.message || '')) return false;
      throw error;
    }
  };
  const ls: LsOperations = {
    exists,
    async stat(absolutePath) {
      if (path.resolve(absolutePath) === root) return { isDirectory: () => true };
      const parent = path.dirname(absolutePath);
      const name = path.basename(absolutePath);
      const entry = (await list(parent)).entries.find(item => item.name === name);
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isDirectory: () => entry.isDirectory };
    },
    async readdir(absolutePath) { return (await list(absolutePath)).entries.map(entry => entry.name); },
  };
  const find: FindOperations = {
    exists,
    async glob(pattern, cwd, options) {
      const start = path.resolve(cwd);
      relative(start, true);
      const match = globMatcher(pattern);
      const found: string[] = [];
      const skippedPaths: Array<{ path: string; code: string }> = [];
      const walk = async (directory: string, prefix: string) => {
        if (input.signal?.aborted) throw new Error('Operation aborted');
        if (found.length >= options.limit) return;
        let entries;
        try { entries = (await list(directory)).entries; } catch (error: any) {
          const code = error?.code || /\b(EACCES|EPERM|ENOENT)\b/.exec(error?.message || '')?.[1];
          if (!['EACCES', 'EPERM', 'ENOENT'].includes(code)) throw error;
          skippedPaths.push({ path: prefix || '.', code }); return;
        }
        for (const entry of entries) {
          const traversalError = (entry as typeof entry & { traversalError?: string }).traversalError;
          if (traversalError) { skippedPaths.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, code: traversalError }); continue; }
          if (DEFAULT_IGNORES.has(entry.name) || options.ignore.some(value => value === entry.name || value === `${entry.name}/`)) continue;
          const candidate = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (!entry.isDirectory && match.test(candidate)) found.push(candidate);
          if (entry.isDirectory) await walk(path.join(directory, entry.name), candidate);
          if (found.length >= options.limit) return;
        }
      };
      await walk(start, '');
      Object.defineProperty(found, 'skippedPaths', { value: skippedPaths });
      return found;
    },
  };
  return { ls, find, root, reference, list, assertRead };
}

const grepSchema = Type.Object({
  pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()),
});

export function createProjectMutationOperations(input: { projectId: string; projectRoot: string; actorUserId: number; actorRole?: string }) {
  const query = createProjectQueryOperations(input);
  const assertWrite = async (absolutePath: string) => { if (input.actorRole && !await isPathWritableByRole(absolutePath, input.actorUserId, input.actorRole)) throw new Error('PROJECT_FILE_WRITE_ACCESS_REVOKED'); };
  const observed = new Map<string, string>();
  const read = async (absolutePath: string) => {
    await query.assertRead(absolutePath);
    const ref = await query.reference(absolutePath);
    const { bytes } = await readProjectWorkspaceFileBytes({ reference: ref, actorUserId: input.actorUserId, maxBytes: 50 * 1024 * 1024 });
    const content = bytes.toString('utf8'); observed.set(path.resolve(absolutePath), content); return Buffer.from(bytes);
  };
  const write = async (absolutePath: string, content: string) => {
    const target = path.resolve(absolutePath); await assertWrite(target); const ref = await query.reference(target);
    const expected = observed.get(target);
    if (expected !== undefined) {
      await compareAndSwapProjectWorkspaceText({ reference: ref, actorUserId: input.actorUserId, expectedContent: expected, content });
      observed.set(target, content); return;
    }
    const exists = await projectWorkspaceEntryExists({ reference: ref, actorUserId: input.actorUserId });
    if (!exists.exists) {
      await writeProjectWorkspaceText({ reference: ref, actorUserId: input.actorUserId, content, exclusive: true });
      observed.set(target, content); return;
    }
    const current = (await readProjectWorkspaceFileBytes({ reference: ref, actorUserId: input.actorUserId, maxBytes: 50 * 1024 * 1024 })).bytes.toString('utf8');
    await compareAndSwapProjectWorkspaceText({ reference: ref, actorUserId: input.actorUserId, expectedContent: current, content });
    observed.set(target, content);
  };
  const mkdir = async (absolutePath: string) => {
    await assertWrite(absolutePath);
    if (path.resolve(absolutePath) === query.root) return;
    const ref = await query.reference(absolutePath);
    await createProjectWorkspaceDirectory({ reference: ref, actorUserId: input.actorUserId, exclusive: false });
  };
  const edit: EditOperations = {
    async access(absolutePath) { if (!(await projectWorkspaceEntryExists({ reference: await query.reference(absolutePath), actorUserId: input.actorUserId })).exists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    readFile: read,
    writeFile: write,
  };
  const writeOps: WriteOperations = { mkdir, writeFile: write };
  return { edit, write: writeOps };
}

export function createProjectGrepTool(input: { projectId: string; projectRoot: string; actorUserId: number; actorRole?: string }): ToolDefinition {
  const operations = createProjectQueryOperations(input);
  const root = operations.root;
  return {
    name: 'grep', label: 'grep',
    description: 'Search file contents for patterns through the current Project storage authority. Bounded files, bytes, matches, and line length; no host fallback.',
    parameters: grepSchema,
    async execute(_id: string, params: any) {
      const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
      const context = Math.min(Math.max(params.context ?? 0, 0), 20);
      const start = path.resolve(root, params.path || '.');
      const startRel = start === root ? '.' : path.relative(root, start).split(path.sep).join('/');
      if (start !== root && !start.startsWith(`${root}${path.sep}`)) throw new Error('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
      const fileGlob = params.glob ? globMatcher(params.glob) : undefined;
      if (params.pattern.length > 500) throw new Error('SEARCH_PATTERN_TOO_LONG');
      if (!params.literal && /(\([^)]*[+*][^)]*\))[+*{]|([+*])\1|\{\d+,\d*\}[+*{]/.test(params.pattern)) throw new Error('UNSAFE_SEARCH_PATTERN');
      let expression: RegExp;
      try { expression = params.literal ? new RegExp(params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), params.ignoreCase ? 'i' : '') : new RegExp(params.pattern, params.ignoreCase ? 'i' : ''); }
      catch { throw new Error('INVALID_SEARCH_PATTERN'); }
      const files: string[] = [];
      const walk = async (directory: string, prefix: string) => {
        if (files.length >= 2_000) return;
        for (const entry of (await operations.list(directory)).entries) {
          if (DEFAULT_IGNORES.has(entry.name)) continue;
          const candidate = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory) await walk(path.join(directory, entry.name), candidate);
          else if (!fileGlob || fileGlob.test(candidate)) files.push(candidate);
          if (files.length >= 2_000) return;
        }
      };
      const startRef = await operations.reference(start, true);
      const startExists = await projectWorkspaceEntryExists({ reference: startRef, actorUserId: input.actorUserId });
      if (!startExists.exists) throw new Error('ENOENT');
      let startIsDirectory = start === root;
      if (!startIsDirectory) {
        const parent = path.dirname(start); const name = path.basename(start);
        startIsDirectory = Boolean((await operations.list(parent)).entries.find(entry => entry.name === name)?.isDirectory);
      }
      if (startIsDirectory) await walk(start, ''); else files.push(path.basename(start));
      const output: string[] = []; const emitted = new Set<string>();
      let totalBytes = 0; let linesTruncated = false;
      for (const relativeFile of files) {
        const absolute = startIsDirectory ? path.join(start, relativeFile) : start;
        const ref = await operations.reference(absolute);
        let bytes: Buffer;
        try { ({ bytes } = await readProjectWorkspaceFileBytes({ reference: ref, actorUserId: input.actorUserId, maxBytes: 2 * 1024 * 1024 })); }
        catch (error: any) { if (/SIZE_LIMIT/.test(error?.message || '')) continue; throw error; }
        totalBytes += bytes.length;
        if (totalBytes > 32 * 1024 * 1024) break;
        if (bytes.includes(0)) continue;
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          expression.lastIndex = 0;
          if (!expression.test(lines[index])) continue;
          const from = Math.max(0, index - context); const to = Math.min(lines.length, index + context + 1);
          for (let current = from; current < to; current++) {
            let line = lines[current]; if (line.length > 500) { line = `${line.slice(0, 500)}…`; linesTruncated = true; }
            const rendered = `${startIsDirectory ? relativeFile : startRel}:${current + 1}:${line}`;
            if (!emitted.has(rendered)) { emitted.add(rendered); output.push(rendered); }
          }
          if (output.length >= limit) break;
        }
        if (output.length >= limit) break;
      }
      const text = output.length ? output.slice(0, limit).join('\n') : 'No matches found';
      return { content: [{ type: 'text', text }], ...(output.length >= limit || linesTruncated ? { details: { ...(output.length >= limit ? { matchLimitReached: limit } : {}), ...(linesTruncated ? { linesTruncated: true } : {}) } } : {}) } as any;
    },
  } as ToolDefinition;
}

const findSchema = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) });
export function createProjectFindTool(input: { projectId: string; projectRoot: string; actorUserId: number; actorRole?: string }): ToolDefinition {
  return {
    name: 'find', label: 'Find', description: 'Find Project files by glob. Returns partial results and skippedPaths when filesystem entries are inaccessible.', parameters: findSchema,
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const operations = createProjectQueryOperations({ ...input, signal });
      const start = path.resolve(input.projectRoot, params.path || '.');
      if (!await operations.find.exists(start)) throw new Error(`Search path not found: ${start}`);
      const limit = Math.min(1000, Math.max(1, Math.floor(params.limit || 1000)));
      const matches = await operations.find.glob(params.pattern, start, { limit, ignore: [] });
      const skippedPaths = (matches as string[] & { skippedPaths?: Array<{ path: string; code: string }> }).skippedPaths || [];
      const warning = skippedPaths.length ? `\nPartial search: skipped ${skippedPaths.length} paths:\n${skippedPaths.map(item => `${item.path}: ${item.code}`).join('\n')}` : '';
      return { content: [{ type: 'text', text: (matches.length ? matches.join('\n') : 'No files found matching pattern') + warning }], details: { skippedPaths, partial: skippedPaths.length > 0, limitReached: matches.length >= limit } };
    },
  } as ToolDefinition;
}
