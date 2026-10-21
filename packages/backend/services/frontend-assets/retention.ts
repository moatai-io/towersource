import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Persist build assets outside replaceable release directories before serving HTML.
 * Only regular Vite content-addressed assets are eligible; never archive HTML,
 * runtime config, SW, uploads or symlinks. No automatic deletion: expiry must
 * account for clients that have not returned since an earlier deployment.
 */
export function retainFrontendAssets(frontendDir: string, dataDir: string): string {
  const source = path.join(frontendDir, 'assets');
  const target = path.join(dataDir, 'frontend-assets');
  fs.mkdirSync(target, { recursive: true });
  if (!fs.existsSync(source)) return target;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !/-[A-Za-z0-9_-]{8,}\.[a-z0-9.]+$/i.test(entry.name)) continue;
    const input = fs.readFileSync(path.join(source, entry.name));
    const output = path.join(target, entry.name);
    if (fs.existsSync(output)) {
      if (!fs.lstatSync(output).isFile() || !fs.readFileSync(output).equals(input)) {
        throw new Error(`Frontend asset collision: ${entry.name}`);
      }
      continue;
    }
    const temporary = path.join(target, `.pending-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(temporary, input, { flag: 'wx', mode: 0o644 });
      // Atomic no-overwrite publication, safe for concurrent process startup.
      try { fs.linkSync(temporary, output); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.lstatSync(output).isFile() || !fs.readFileSync(output).equals(input)) throw error;
      }
    } finally {
      fs.unlinkSync(temporary);
    }
  }
  return target;
}
