import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelWorkbenchJob, getWorkbenchJob, listWorkbenchJobs } from '../execution/jobs/job-registry.js';
import { requestLocalWorkbenchJobCancel } from './workbench-job-runner.js';
import { requestRemoteWorkbenchJobCancel } from '../execution/remote-job-runner.js';
import { listServices, readServiceLogs, stopService } from './service-registry.js';
import {
  inspectWorkbenchProcess,
  listWorkbenchProcesses,
  parseWorkbenchProcessHandle,
  readWorkbenchProcessLogs,
  stopWorkbenchProcess,
  WorkbenchProcessError,
} from './workbench-process-control.js';

vi.mock('../execution/jobs/job-registry.js', () => ({
  getWorkbenchJob: vi.fn(), listWorkbenchJobs: vi.fn(), cancelWorkbenchJob: vi.fn(),
}));
vi.mock('./workbench-job-runner.js', () => ({ requestLocalWorkbenchJobCancel: vi.fn() }));
vi.mock('../execution/remote-job-runner.js', () => ({ requestRemoteWorkbenchJobCancel: vi.fn() }));
vi.mock('./service-registry.js', () => ({
  listServices: vi.fn(), readServiceLogs: vi.fn(), stopService: vi.fn(),
}));

const job = {
  id: 41, project_id: 'p', status: 'running', command: 'npm test', cwd: '/workspace',
  started_at: '2026-08-04T01:00:00Z', finished_at: null, exit_code: null,
  error_code: null, error_summary: null, stdout_text: 'partial', stderr_text: '',
} as any;
const service = {
  id: 88, project_id: 'p', status: 'running', command: 'python -m http.server 8123', cwd: '/workspace',
  started_at: '2026-08-04T02:00:00Z', stopped_at: null, last_error: null,
  external_url: '/preview/x', internal_port: 8123,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWorkbenchJobs).mockResolvedValue([job]);
  vi.mocked(listServices).mockResolvedValue([service]);
  vi.mocked(getWorkbenchJob).mockResolvedValue(job);
  vi.mocked(readServiceLogs).mockResolvedValue('ready');
});

describe('Project Shell common process control', () => {
  it('requires an opaque kind-prefixed handle', () => {
    expect(parseWorkbenchProcessHandle('job:41')).toEqual({ kind: 'job', id: 41 });
    expect(parseWorkbenchProcessHandle('service:88')).toEqual({ kind: 'service', id: 88 });
    for (const invalid of ['41', 'job:0', 'service:-1', 'remote:3']) {
      expect(() => parseWorkbenchProcessHandle(invalid)).toThrow(WorkbenchProcessError);
    }
  });

  it('lists Jobs and Services under one normalized state contract', async () => {
    await expect(listWorkbenchProcesses('p', 20)).resolves.toEqual([
      expect.objectContaining({ handle: 'service:88', kind: 'service', state: 'running', port: 8123 }),
      expect.objectContaining({ handle: 'job:41', kind: 'job', state: 'running', durable: true }),
    ]);
    expect(listServices).toHaveBeenCalledWith('p', expect.objectContaining({ statusFilter: expect.arrayContaining(['running', 'stopped']) }));
  });

  it('re-checks Project ownership on inspect instead of trusting the numeric id', async () => {
    vi.mocked(getWorkbenchJob).mockResolvedValue(undefined);
    await expect(inspectWorkbenchProcess('other-project', 'job:41')).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' });
  });

  it('reads Job output and Service logs through one action', async () => {
    await expect(readWorkbenchProcessLogs('p', 'job:41')).resolves.toMatchObject({ handle: 'job:41', stdout: 'partial', complete: false });
    await expect(readWorkbenchProcessLogs('p', 'service:88', 25)).resolves.toMatchObject({ handle: 'service:88', stdout: 'ready' });
    expect(readServiceLogs).toHaveBeenCalledWith(88, 25);
  });

  it('cancels Jobs and hard-signals the owned local runner', async () => {
    vi.mocked(cancelWorkbenchJob).mockResolvedValue({ ...job, status: 'cancel_requested' });
    vi.mocked(requestLocalWorkbenchJobCancel).mockReturnValue(true);
    await expect(stopWorkbenchProcess('p', 'job:41')).resolves.toMatchObject({
      process: { handle: 'job:41', state: 'stopping' }, localProcessSignalled: true,
    });
  });

  it('routes remote Job cancellation to its owning transport rather than the local process map', async () => {
    vi.mocked(cancelWorkbenchJob).mockResolvedValue({
      ...job, provider_kind: 'remote-worker', status: 'cancel_requested',
    });
    vi.mocked(requestRemoteWorkbenchJobCancel).mockReturnValue(true);
    await expect(stopWorkbenchProcess('p', 'job:41')).resolves.toMatchObject({
      process: { handle: 'job:41', state: 'stopping' }, localProcessSignalled: true,
    });
    expect(requestRemoteWorkbenchJobCancel).toHaveBeenCalledWith(41);
    expect(requestLocalWorkbenchJobCancel).not.toHaveBeenCalled();
  });

  it('stops Services through the same action', async () => {
    await expect(stopWorkbenchProcess('p', 'service:88')).resolves.toMatchObject({ process: { handle: 'service:88', state: 'stopped' } });
    expect(stopService).toHaveBeenCalledWith(88);
  });
});

describe('download process evidence', () => {
 it('does not confuse process heartbeat with transfer evidence', async () => {
  const { buildDownloadCommand } = await import('../execution/downloads/download-contract.js');
  const { projectWorkbenchJob } = await import('./workbench-process-control.js');
  const job={id:1,project_id:'p',status:'running',command:buildDownloadCommand({url:'https://dataset.example/data',destination:'data'}),stdout_text:null} as any;
  expect(projectWorkbenchJob(job).download?.observation).toBe('unverified');
  job.stdout_text='TOWER_DOWNLOAD_PROGRESS '+JSON.stringify({phase:'transferring',bytesWritten:10,bytesReceived:10,observedAt:Date.now()/1000-200,lastDiskGrowthAt:Date.now()/1000-200,attempt:1});
  expect(projectWorkbenchJob(job).download?.observation).toBe('stale');
  job.stdout_text='TOWER_DOWNLOAD_PROGRESS '+JSON.stringify({phase:'transferring',bytesWritten:10,bytesReceived:10,observedAt:Date.now()/1000,lastDiskGrowthAt:Date.now()/1000,attempt:1});
  expect(projectWorkbenchJob(job).download?.observation).toBe('receiving_bytes');
  job.status='failed';expect(projectWorkbenchJob(job).download?.observation).toBe('interrupted');
  job.stdout_text='TOWER_DOWNLOAD_PROGRESS '+JSON.stringify({phase:'blocked',bytesWritten:10,observedAt:Date.now()/1000,attempt:1,errorCode:'RANGE_MISMATCH',nextAction:'Inspect remote metadata'});
  expect(projectWorkbenchJob(job).download).toMatchObject({observation:'blocked',nextAction:'Inspect remote metadata'});
 });
});
