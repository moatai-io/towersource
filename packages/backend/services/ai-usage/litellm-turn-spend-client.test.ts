import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ credentials: vi.fn() }));
vi.mock('../ai/litellm-credentials.js', () => ({ resolveLiteLLMCredentials: mocks.credentials }));
import { fetchLiteLLMTurnSpend } from './litellm-turn-spend-client.js';

const turn = 'turn_abc';
const row = { requestId: 'req-1', rootTurnId: turn, spend: '0.00000012', status: 'success' };
const response = (rows: unknown, rootTurnId = turn, complete = true) => new Response(JSON.stringify({ source: 'litellm-spendlogs', root_turn_id: rootTurnId, complete, rows }), { status: 200 });

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.credentials.mockReset().mockResolvedValue({ baseUrl: 'https://router.example.com/v1', apiKey: 'synthetic-key' });
});

describe('bounded turn SpendLogs client', () => {
  it('uses the VM virtual key and sends only the root turn selector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([row]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchLiteLLMTurnSpend(turn)).toEqual([row]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://router.example.com/usage-self-service/v1/turn-spend?root_turn_id=turn_abc');
    expect(String(url)).not.toMatch(/api_key|team_id/);
    expect(init.headers.Authorization).toBe('Bearer synthetic-key');
  });

  it('rejects foreign turns, malformed rows and unbounded responses before reconciliation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([row], 'other'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('scope');
    fetchMock.mockResolvedValue(response([{ ...row, rootTurnId: 'other' }]));
    await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('row');
    fetchMock.mockResolvedValue(response(Array(501).fill(row)));
    await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('row limit');
    fetchMock.mockResolvedValue(response([row], turn, false));
    await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('scope or row limit');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects oversized payloads and unpriced rows even when the row count is small', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(' '.repeat(256 * 1024 + 1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('too large');
    fetchMock.mockResolvedValue(response([{ ...row, spend: null }]));
    await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('invalid turn spend row');
  });

  it('never sends an invalid identifier to the Router', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLiteLLMTurnSpend('../other')).rejects.toThrow('invalid root turn id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it('normalizes Router snake_case rows and rejects mixed or duplicate identifiers',async()=>{
 const wire={request_id:'req-1',root_turn_id:turn,spend:'0.0001',status:'success'};
 const f=vi.fn().mockResolvedValue(response([wire]));vi.stubGlobal('fetch',f);
 expect(await fetchLiteLLMTurnSpend(turn)).toEqual([{requestId:'req-1',rootTurnId:turn,spend:'0.0001',status:'success'}]);
 f.mockResolvedValue(response([{...wire,requestId:'other'}]));await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('ambiguous');
 f.mockResolvedValue(response([wire,wire]));await expect(fetchLiteLLMTurnSpend(turn)).rejects.toThrow('invalid');
});
