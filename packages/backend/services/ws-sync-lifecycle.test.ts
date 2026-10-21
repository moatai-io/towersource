import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), enabled: vi.fn(() => true) }));
vi.mock('../db/pg.js', () => ({ getPgPool: () => ({ connect: mocks.connect }), isPgEnabled: mocks.enabled }));
import { initWsSync, stopWsSync } from './ws-sync.js';
const handlers = { all: vi.fn(), session: vi.fn(), user: vi.fn() };
const client = () => ({ query: vi.fn().mockResolvedValue({}), on: vi.fn(), release: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); });
afterEach(async () => { await stopWsSync(); });
describe('WS sync connection ownership', () => {
  it('discards every failed LISTEN client and allows later initialization', async () => {
    const failed = client(); failed.query.mockRejectedValue(new Error('synthetic LISTEN failure'));
    const recovered = client();
    mocks.connect.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered);
    await initWsSync('test', handlers);
    expect(failed.release).toHaveBeenCalledExactlyOnceWith(true);
    await initWsSync('test', handlers);
    expect(recovered.query).toHaveBeenCalledWith('LISTEN tower_ws_events');
    expect(recovered.release).not.toHaveBeenCalled();
    await stopWsSync();
    expect(recovered.query).toHaveBeenCalledWith('UNLISTEN tower_ws_events');
    expect(recovered.release).toHaveBeenCalledTimes(1);
    expect(failed.release).toHaveBeenCalledTimes(1);
  });
  it('handles connection acquisition failure without releasing another client', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('synthetic connect failure'));
    await expect(initWsSync('test', handlers)).resolves.toBeUndefined();
    const next = client(); mocks.connect.mockResolvedValueOnce(next);
    await initWsSync('test', handlers);
    await initWsSync('test', handlers);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(next.release).not.toHaveBeenCalled();
  });
  it('never acquires a connection with PostgreSQL disabled', async () => {
    mocks.enabled.mockReturnValue(false);
    await initWsSync('test', handlers);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
