/**
 * Selects only a single, already Agent-bound GWS account. A users/<id> bundle is
 * evidence of legacy personal ownership, even if it currently contains one user.
 * Do not promote it, pick the requester, or fall back to CLI account discovery.
 * Reconnect/migrate with account-owner consent instead. No secret values in errors.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const AGENT_GWS_MIGRATION_ERROR = 'AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED: Reconnect this Agent Google connection with account-owner consent using a single root credentials.json; personal, multiple-account, linked, or cache-only bundles cannot be selected safely.';

/** Pure inventory policy, shared by host/Worker and the local container script. */
export function selectAgentGwsCredentialRelativePath(entries: string[]): 'credentials.json' {
  if (!entries.includes('credentials.json') || entries.some(entry => entry.startsWith('users/')
    || entry.startsWith('accounts/')
    || /(?:^|\/)(?:credentials[^/]*|token_cache[^/]*|accounts\.json)$/.test(entry)
      && entry !== 'credentials.json' && entry !== 'token_cache.json')) {
    throw new Error(AGENT_GWS_MIGRATION_ERROR);
  }
  return 'credentials.json';
}

/** Reads only the ephemeral extracted bundle; never changes its ownership or files. */
export async function resolveAgentGwsCredentialPath(gwsConfigDir: string): Promise<string> {
  const entries: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(AGENT_GWS_MIGRATION_ERROR);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else entries.push(relative);
    }
  }
  try {
    if (!(await fs.lstat(gwsConfigDir)).isDirectory()) throw new Error(AGENT_GWS_MIGRATION_ERROR);
    await walk(gwsConfigDir, '');
    const selected = path.join(gwsConfigDir, selectAgentGwsCredentialRelativePath(entries));
    const parsed: unknown = JSON.parse(await fs.readFile(selected, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(AGENT_GWS_MIGRATION_ERROR);
    await fs.chmod(selected, 0o600);
    return selected;
  } catch {
    throw new Error(AGENT_GWS_MIGRATION_ERROR);
  }
}

/**
 * Read a bounded plain tar/ustar bundle without extracting archive-supplied paths.
 * Links, PAX/GNU extensions, duplicate entries and non-canonical paths fail closed.
 * OAuth-generated bundles use short root paths and need none of those features.
 */
function readBoundedGwsArchive(encoded: string): Array<{ name: string; content: Buffer }> {
  try {
    if (encoded.length > 8 * 1024 * 1024) throw new Error();
    const archive = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 4 * 1024 * 1024 });
    const files: Array<{ name: string; content: Buffer }> = [];
    const seen = new Set<string>();
    let offset = 0;
    let terminated = false;
    const text = (header: Buffer, start: number, length: number) => {
      const field = header.subarray(start, start + length);
      const zero = field.indexOf(0);
      if (zero >= 0 && field.subarray(zero).some(byte => byte !== 0)) throw new Error();
      return field.subarray(0, zero < 0 ? field.length : zero).toString('utf8');
    };
    const octal = (header: Buffer, start: number, length: number) => {
      const value = header.subarray(start, start + length).toString('ascii').replace(/[\0 ]+$/g, '').trim();
      if (!/^[0-7]+$/.test(value)) throw new Error();
      return Number.parseInt(value, 8);
    };
    while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) {
        if (archive.length - offset < 1024 || archive.subarray(offset).some(byte => byte !== 0)) throw new Error();
        terminated = true;
        break;
      }
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== octal(header, 148, 8)) throw new Error();
      const type = header[156];
      if (type !== 0 && type !== 48 && type !== 53) throw new Error();
      const prefix = text(header, 345, 155);
      let name = `${prefix ? `${prefix}/` : ''}${text(header, 0, 100)}`;
      if (type === 53 && name.endsWith('/')) name = name.slice(0, -1);
      if (!/^gws(?:\/[A-Za-z0-9_.-]+)*$/.test(name)
        || name.split('/').some(part => part === '.' || part === '..')
        || (type !== 53 && name === 'gws') || seen.has(name)) throw new Error();
      seen.add(name);
      if (seen.size > 128) throw new Error();
      const size = octal(header, 124, 12);
      if ((type === 53 && size !== 0) || size > 1024 * 1024 || offset + 512 + size > archive.length) throw new Error();
      if (type !== 53) files.push({ name: name.slice(4), content: archive.subarray(offset + 512, offset + 512 + size) });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (!terminated) throw new Error();
    return files;
  } catch {
    throw new Error(AGENT_GWS_MIGRATION_ERROR);
  }
}

export function decodeAgentGwsBundle(encoded: string): Array<{ name: string; content: Buffer }> {
  try {
    const files = readBoundedGwsArchive(encoded);
    selectAgentGwsCredentialRelativePath(files.map(file => file.name));
    const credential: any = JSON.parse(files.find(file => file.name === 'credentials.json')!.content.toString('utf8'));
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)
      || !['authorized_user', 'service_account'].includes(credential.type)) throw new Error();
    // credentials.json is the only portable source of truth for both
    // authorized_user and service_account credentials. OAuth client files and
    // token caches are flow/runtime-local and must never cross executions.
    return files.filter(file => file.name === 'credentials.json');
  } catch {
    throw new Error(AGENT_GWS_MIGRATION_ERROR);
  }
}

/** Destination is a freshly created run directory; no tar extraction is performed. */
export async function materializeAgentGwsBundle(encoded: string, configRoot: string): Promise<string> {
  const files = decodeAgentGwsBundle(encoded);
  const gwsDir = path.join(configRoot, 'gws');
  await fs.mkdir(gwsDir, { mode: 0o700 });
  for (const file of files) await fs.writeFile(path.join(gwsDir, file.name), file.content, { mode: 0o600, flag: 'wx' });
  return path.join(gwsDir, 'credentials.json');
}

/** Server-side compatibility transform, called only after the approved binding
 * and its live audience have been checked. No filesystem, token refresh, or
 * requester-driven account selection. Pin the exact reviewed archive bytes.
 */
export function normalizeApprovedLegacyGwsBundle(encoded: string, approval: {
  bundleSha256: string; credentialPath: string;
}): string {
  try {
    if (!/^[a-f0-9]{64}$/.test(approval.bundleSha256)
      || createHash('sha256').update(encoded).digest('hex') !== approval.bundleSha256
      || !/^(?:users\/[0-9]+\/)?credentials\.json$/.test(approval.credentialPath)) throw new Error();
    const files = readBoundedGwsArchive(encoded);
    const selected = files.find(file => file.name === approval.credentialPath);
    if (!selected) throw new Error();
    const credential = JSON.parse(selected.content.toString('utf8'));
    if (!credential || credential.type !== 'authorized_user'
      || ['client_id', 'client_secret', 'refresh_token'].some(key => typeof credential[key] !== 'string' || !credential[key].trim())) throw new Error();
    // Preserve exact selected credential bytes. Do not inherit other accounts'
    // token caches or a root client_secret.json of uncertain provenance.
    const header = Buffer.alloc(512);
    header.write('gws/credentials.json');
    header.write('0000600\0', 100, 8);
    header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(selected.content.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156); header.write('0', 156, 1);
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    const result = gzipSync(Buffer.concat([header, selected.content,
      Buffer.alloc((512 - selected.content.length % 512) % 512), Buffer.alloc(1024)])).toString('base64');
    decodeAgentGwsBundle(result); // Same strict consumer contract as Host/Worker.
    return result;
  } catch {
    throw new Error(AGENT_GWS_MIGRATION_ERROR);
  }
}
