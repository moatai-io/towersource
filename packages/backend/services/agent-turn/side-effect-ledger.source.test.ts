import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ledger = fs.readFileSync(path.resolve(import.meta.dirname, './side-effect-ledger.ts'), 'utf8');
const wrapper = fs.readFileSync(path.resolve(import.meta.dirname, './side-effect-tool-wrapper.ts'), 'utf8');
const assembly = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi/tool-assembly.ts'), 'utf8');

describe('side effect recovery ledger contract', () => {
  it('uses exact tool-call identity normally and semantic identity only during recovery', () => {
    expect(ledger).toContain('const operationId = `${params.rootTurnId}:${params.toolName}:${params.toolCallId}`');
    expect(ledger).toContain('params.recovering');
    expect(ledger).toContain('tool_name = $2 AND semantic_hash = $3');
    expect(ledger).toContain("SET status = 'uncertain'");
  });

  it('reuses succeeded results and blocks running or uncertain repeats', () => {
    expect(ledger).toContain("prior?.status === 'succeeded'");
    expect(ledger).toContain("prior?.status === 'uncertain'");
    expect(ledger).toContain("prior?.status === 'running'");
    expect(wrapper).toContain("claim.kind === 'reuse'");
    expect(wrapper).toContain("claim.kind === 'block'");
  });

  it('wraps both restricted and legacy Pi tool surfaces at the common boundary', () => {
    expect(assembly.match(/wrapToolsWithSideEffectLedger/g)?.length).toBeGreaterThanOrEqual(3);
    expect(assembly).toContain('wrapToolsWithSideEffectLedger(wrapToolsWithExecutionGateShadow(capabilityTools');
    expect(assembly).toContain('wrapToolsWithSideEffectLedger(wrapToolsWithExecutionGateShadow(guardedCustomTools');
  });
});
