/** Real local execution boundary; credentials/DB are deliberately not involved. */
import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';

async function running(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // An exited child can remain a zombie briefly until its parent reaps it.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

describe.skipIf(process.platform !== 'linux')('native Operator process lifecycle', () => {
  it.each(['timeout', 'abort'] as const)('stops the shell and ordinary descendant on %s', async mode => {
    const controller = new AbortController();
    let output = '';
    let pids: number[] = [];
    try {
      const execution = createLocalBashOperations().exec(
        'sleep 30 & child=$!; printf "PIDS:%s:%s\\n" "$$" "$child"; wait "$child"',
        process.cwd(), {
          env: { PATH: '/usr/bin:/bin', HOME: process.cwd() },
          timeout: mode === 'timeout' ? 1 : 5,
          signal: controller.signal,
          onData: data => {
            output += data.toString();
            const match = output.match(/PIDS:(\d+):(\d+)/);
            if (match && pids.length === 0) {
              pids = [Number(match[1]), Number(match[2])];
              if (mode === 'abort') controller.abort();
            }
          },
        },
      );
      await expect(execution).rejects.toThrow(mode === 'timeout' ? 'timeout:1' : 'aborted');
      expect(pids).toHaveLength(2);
      await expect.poll(async () => Promise.all(pids.map(running)), { timeout: 2000 }).toEqual([false, false]);
    } finally {
      controller.abort();
      // Only clean up PIDs emitted by this test's own shell.
      for (const pid of pids) {
        if (await running(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }
  }, 10000);
});
