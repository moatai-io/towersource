import { createHash, randomUUID } from 'node:crypto';

export interface FileCanaryPort {
  /** Must use current user admission and the Agent execution broker; never direct fs. */
  execute(command: string): Promise<{ exitCode: number; stdout: string }>;
  /** Authenticated /api/files/read for the same principal and Project. */
  read(relativePath: string): Promise<string>;
}
export interface FileCanaryReport {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  scope: 'execution-file-api';
  scratch: string;
  checks: string[];
  cleanup: 'not-needed' | 'verified' | 'unverified';
  unverified: string[];
  failure?: string;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Deliberately no retry: a lost execute response can mean the write happened. */
export async function runFileRoundtripCanary(port: FileCanaryPort): Promise<FileCanaryReport> {
  const nonce = randomUUID();
  const scratch = `.tower-file-canary-${nonce}`;
  const file = `${scratch}/probe.txt`;
  const marker = `${scratch}/owner`;
  const first = `canary ${nonce} revision 1\n`;
  const second = `canary ${nonce} revision 2\n`;
  const report: FileCanaryReport = {
    status: 'FAIL', scope: 'execution-file-api', scratch, checks: [], cleanup: 'not-needed',
    unverified: ['browser', 'download', 'tool-cli', 'model-session', 'negative-acl', 'worker-failure-injection'],
  };
  let owned = false;
  let stage = 'create';
  const exec = async (command: string) => {
    const result = await port.execute(command);
    if (result.exitCode !== 0) throw new Error('EXECUTION_FAILED');
    return result.stdout;
  };
  try {
    // mkdir is exclusive; noclobber refuses unexpected entries; no recursive deletion.
    report.cleanup = 'unverified';
    await exec(`set -eu; umask 077; mkdir ${quote(scratch)}; set -C; printf %s ${quote(nonce)} > ${quote(marker)}; printf %s ${quote(first)} > ${quote(file)}`);
    owned = true;
    report.checks.push('exclusive-create');
    stage = 'read-first';
    if (hash(await port.read(file)) !== hash(first)) throw new Error('HASH_MISMATCH');
    report.checks.push('api-first-hash');
    stage = 'update';
    await exec(`set -eu; test ! -L ${quote(scratch)}; test ! -L ${quote(marker)}; test ! -L ${quote(file)}; test "$(cat ${quote(marker)})" = ${quote(nonce)}; printf %s ${quote(second)} > ${quote(file)}`);
    stage = 'read-updated';
    if (hash(await port.read(file)) !== hash(second)) throw new Error('HASH_MISMATCH');
    report.checks.push('api-updated-hash');
    report.status = 'PASS';
  } catch {
    report.failure = stage; // Do not copy provider output, tokens or private paths into reports.
  } finally {
    if (owned) {
      try {
        await exec(`set -eu; test ! -L ${quote(scratch)}; test ! -L ${quote(marker)}; test ! -L ${quote(file)}; test "$(cat ${quote(marker)})" = ${quote(nonce)}; rm -- ${quote(file)} ${quote(marker)}; rmdir -- ${quote(scratch)}; test ! -e ${quote(scratch)}`);
        report.cleanup = 'verified';
      } catch { report.status = 'FAIL'; report.failure = 'cleanup'; }
    }
  }
  return report;
}
