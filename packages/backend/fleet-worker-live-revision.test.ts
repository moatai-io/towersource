import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../../scripts/fleet/finalize-worker-after-cutover', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('verify_worker_store()'), source.indexOf('\ncase "$mode" in'));
function check(exec: string, pid = '123', liveExit = 0) {
  return spawnSync('bash', ['-c', `set -euo pipefail
worker_unit=synthetic-worker
systemctl() {
  case "$*" in
    *ExecStart*) printf '%s\\n' "$TEST_EXEC" ;;
    *MainPID*) printf '%s\\n' "$TEST_PID" ;;
  esac
}
sudo() { cat >/dev/null; return "$TEST_LIVE_EXIT"; }
${fn}
verify_worker_store /nix/store/synthetic-release
`], { encoding: 'utf8', env: { ...process.env, TEST_EXEC: exec, TEST_PID: pid, TEST_LIVE_EXIT: String(liveExit) } });
}
const current = '{ path=/nix/store/synthetic-release/bin/tower-workbench-worker ; argv[]=launcher ; }';
it('rejects an old configured Worker even with a live PID', () => {
  const result = check('{ path=/nix/store/old/bin/tower-workbench-worker ; }');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('WORKER_REVISION_DRIFT');
});
it('rejects a missing live Worker PID', () => {
  expect(check(current, '0').status).not.toBe(0);
});
it('propagates a failed live process inspection', () => {
  expect(check(current, '123', 1).status).not.toBe(0);
});
it('accepts matching configuration and successful live inspection', () => {
  expect(check(current).status).toBe(0);
});
it('checks exact live entrypoint without dumping process arguments', () => {
  expect(fn).toContain('if expected not in args:');
  expect(fn).toContain("read_bytes().split(b'\\0')");
  expect(fn).not.toContain('print(args)');
  expect(source.indexOf('    verify_worker_store "$store"')).toBeLessThan(source.indexOf("    printf '{\"status\":\"verified\""));
});
