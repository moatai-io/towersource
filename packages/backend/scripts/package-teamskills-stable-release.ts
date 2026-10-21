#!/usr/bin/env node
/** Offline packaging only. Review artifacts before separately publishing a release. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { signStableSkillRelease } from '../services/skill/stable-release-package.js';

function main(args: string[]): void {
  const allowed = ['--source-root', '--tag', '--commit', '--private-key', '--output-dir'];
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || opts.has(args[i])) throw new Error('expected --source-root --tag --commit --private-key --output-dir');
    opts.set(args[i], args[i + 1]);
  }
  if (opts.size !== allowed.length) throw new Error('required packaging arguments missing');
  const output = path.resolve(opts.get('--output-dir')!);
  if (fs.realpathSync(output) !== output || !fs.lstatSync(output).isDirectory() || fs.readdirSync(output).length !== 0) throw new Error('output directory must exist, be regular, and empty');
  const source = path.resolve(opts.get('--source-root')!);
  if (output === source || output.startsWith(source + path.sep)) throw new Error('output must be outside the source tree');
  const keyFile = path.resolve(opts.get('--private-key')!);
  if (fs.realpathSync(keyFile) !== keyFile || !fs.lstatSync(keyFile).isFile()) throw new Error('unsafe signing key path');
  if (keyFile === source || keyFile.startsWith(source + path.sep)) throw new Error('signing key must be outside the source tree');
  // The signed commit must describe the exact checked-out tree, not a caller
  // assertion. Keep git output out of receipts and logs.
  const git = (args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (git(['rev-parse', '--show-toplevel']) !== source || git(['rev-parse', 'HEAD']) !== opts.get('--commit')
    || git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('source must be a clean Git root at exact commit');
  const { descriptor, signature, archive } = signStableSkillRelease(source, opts.get('--tag')!, opts.get('--commit')!, fs.readFileSync(keyFile));
  const assets = [['tower-skill-release.json', descriptor], ['tower-skill-release.sig', signature], ['tower-skills.tar.gz', archive]] as const;
  for (const [name, bytes] of assets) fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'packaged', tag: opts.get('--tag'), files: assets.map(([name]) => name) }));
}
try { main(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : 'packaging failed'); process.exitCode = 1; }
