/**
 * Owns: local-disk streaming storage for resumable uploads.
 * Public API: writeChunkStream, finalizeFile, cleanup helpers.
 * See README.md.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { IncomingMessage } from 'http';
import { chunkPath, chunkTmpPath, resolveFinalUploadPath, stagingRootForSession } from './resumable-upload-paths.js';

export async function ensureSessionStaging(projectRoot: string, sessionId: string): Promise<void> {
  await fsp.mkdir(stagingRootForSession(projectRoot, sessionId), { recursive: true });
}

export async function chunkExists(projectRoot: string, sessionId: string, fileId: string, chunkIndex: number): Promise<{ exists: boolean; size: number }> {
  const p = chunkPath(projectRoot, sessionId, fileId, chunkIndex);
  try {
    const stat = await fsp.stat(p);
    return { exists: true, size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export async function writeChunkStream(params: {
  projectRoot: string;
  sessionId: string;
  fileId: string;
  chunkIndex: number;
  stream: IncomingMessage;
}): Promise<{ path: string; size: number }> {
  const finalPath = chunkPath(params.projectRoot, params.sessionId, params.fileId, params.chunkIndex);
  const tmpPath = chunkTmpPath(params.projectRoot, params.sessionId, params.fileId, params.chunkIndex);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await pipeline(params.stream, fs.createWriteStream(tmpPath, { flags: 'wx' }));
  const stat = await fsp.stat(tmpPath);
  await fsp.rename(tmpPath, finalPath);
  return { path: finalPath, size: stat.size };
}

export async function finalizeFile(params: {
  projectRoot: string;
  sessionId: string;
  fileId: string;
  targetDir: string;
  relativePath: string;
  chunkCount: number;
  overwrite: boolean;
}): Promise<{ finalPath: string; size: number }> {
  const finalPath = resolveFinalUploadPath(params.targetDir, params.relativePath);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  const exists = await fsp.stat(finalPath).then(() => true).catch(() => false);
  if (exists && !params.overwrite) {
    const err = new Error('Final path already exists') as Error & { code?: string };
    err.code = 'PATH_CONFLICT';
    throw err;
  }

  const tmpFinalPath = path.join(path.dirname(finalPath), `.uploading-${path.basename(finalPath)}-${params.sessionId}`);
  const out = fs.createWriteStream(tmpFinalPath, { flags: 'w' });
  let size = 0;
  try {
    for (let i = 0; i < params.chunkCount; i++) {
      const cp = chunkPath(params.projectRoot, params.sessionId, params.fileId, i);
      const stat = await fsp.stat(cp);
      size += stat.size;
      await pipeline(fs.createReadStream(cp), out, { end: false });
    }
    out.end();
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    await fsp.rename(tmpFinalPath, finalPath);
    return { finalPath, size };
  } catch (err) {
    out.destroy();
    await fsp.unlink(tmpFinalPath).catch(() => {});
    throw err;
  }
}

export async function removeSessionStaging(projectRoot: string, sessionId: string): Promise<void> {
  await fsp.rm(stagingRootForSession(projectRoot, sessionId), { recursive: true, force: true });
}

export async function directorySizeBytes(dir: string, opts?: { excludeDirNames?: Set<string> }): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && opts?.excludeDirNames?.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {}
      }
    }
  }
  await walk(dir);
  return total;
}
