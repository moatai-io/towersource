import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ getPgPool: vi.fn(() => { throw new Error('unexpected pool access'); }) }));
vi.mock('../../db/pg.js', () => mocks);
import { feedbackIntakeRouter, startFeedbackDelivery, stopFeedbackDelivery } from './runtime.js';
afterEach(() => { stopFeedbackDelivery(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('central feedback activation wiring', () => {
  it('mounts bounded intake before the global JSON parser and broad API auth', () => {
    const source = readFileSync('packages/backend/index.ts', 'utf8');
    const mount = source.indexOf("app.use('/api/feedback-intake', feedbackIntakeRouter())");
    expect(mount).toBeGreaterThan(0);
    expect(mount).toBeLessThan(source.indexOf("app.use(express.json({ limit: '10mb' }))"));
    expect(mount).toBeLessThan(source.indexOf("app.use('/api', apiRouter)"));
    expect(source).toContain('startFeedbackDelivery();');
    expect(source).toContain('function beginShutdown(');
    expect(source).toContain("process.on('SIGINT', () => beginShutdown('SIGINT'))");
    expect(source).toContain("process.on('SIGTERM', () => beginShutdown('SIGTERM'))");
    expect(source.match(/stopFeedbackDelivery\(\);/g)).toHaveLength(1);
  });
  it('does not put the feedback schema into the auto-migration scanner', () => {
    expect(readdirSync('packages/backend/db/migrations').some(name => /feedback/i.test(name))).toBe(false);
    expect(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')).toContain('UNIQUE (tenant_id, idempotency_key)');
  });
  it.each(['disabled', 'candidate'])('never touches PG or starts sends when %s', mode => {
    vi.stubEnv('TOWER_FEEDBACK_INTAKE_ENABLED', mode === 'candidate' ? 'true' : 'false');
    vi.stubEnv('TOWER_FEEDBACK_DELIVERY_ENABLED', 'true');
    vi.stubEnv('TOWER_CANDIDATE_PASSIVE_MODE', mode === 'candidate' ? 'true' : 'false');
    expect(feedbackIntakeRouter()).toBeDefined(); startFeedbackDelivery();
    expect(mocks.getPgPool).not.toHaveBeenCalled();
  });
});
