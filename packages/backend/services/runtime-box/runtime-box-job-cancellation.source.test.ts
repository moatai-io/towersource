import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const execSource = source.slice(source.indexOf('async function execDockerCommand'), source.indexOf('/**\n * 컨테이너 stop'));

describe('Runtime Box durable Job cancellation boundary', () => {
  it('runs cancellable execs in a dedicated process group and kills the group before docker exec detaches', () => {
    expect(execSource).toContain('exec setsid --wait sh -c');
    expect(execSource).toContain('/usr/bin/kill -TERM -- "-$pid"');
    expect(execSource).toContain('/usr/bin/kill -KILL -- "-$pid"');
    expect(execSource).toContain("ps -eo pgid=,stat= | awk -v pgid=\"$pid\"");
    expect(execSource).toContain("$2 !~ /^Z/");
    expect(execSource).toContain('PROCESS_TREE_STILL_RUNNING');
    expect(execSource).toContain('onAbort: killExecutionGroup');
  });

  it('limits process-group cancellation machinery to callers that provide an AbortSignal', () => {
    expect(execSource).toContain('const cancellationPidFile = req.signal');
    expect(execSource).toContain("? `/tmp/tower-exec-");
  });
});
