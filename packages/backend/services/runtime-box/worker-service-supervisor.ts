/** Owns in-process service handles, not user-writable PID files.
 * Launchers provide a server-authorized Workstation or explicitly sandboxed child
 * and retain credentials until child exit. The supervisor does not choose isolation.
 * No HTTP authority or restart persistence is implied by this primitive.
 */
export interface SupervisedServiceChild {
  exited: Promise<{ code: number | null }>;
  terminate(): void;
  kill(): void;
}
export interface SupervisedServiceView {
  projectId: string;
  serviceId: string;
  state: 'starting' | 'running' | 'stopping' | 'exited' | 'failed';
  exitCode: number | null;
}
interface Entry { view: SupervisedServiceView; ready: Promise<void>; child?: SupervisedServiceChild; stop?: Promise<void>; }

export class WorkerServiceSupervisor {
  private entries = new Map<string, Entry>();
  private closing = false;
  constructor(private graceMs = 500) {}
  private key(projectId: string, serviceId: string): string {
    if (!projectId || !serviceId) throw new Error('WORKER_SERVICE_ID_REQUIRED');
    return JSON.stringify([projectId, serviceId]);
  }
  status(projectId: string, serviceId: string): SupervisedServiceView | undefined {
    const view = this.entries.get(this.key(projectId, serviceId))?.view;
    return view ? { ...view } : undefined;
  }
  async start(projectId: string, serviceId: string, launch: () => Promise<SupervisedServiceChild>): Promise<SupervisedServiceView> {
    if (this.closing) throw new Error('WORKER_SERVICE_SUPERVISOR_CLOSING');
    const key = this.key(projectId, serviceId);
    const previous = this.entries.get(key);
    if (previous && !['exited', 'failed'].includes(previous.view.state)) throw new Error('WORKER_SERVICE_ALREADY_ACTIVE');
    let release!: () => void;
    const entry: Entry = { view: { projectId, serviceId, state: 'starting', exitCode: null }, ready: new Promise(resolve => { release = resolve; }) };
    this.entries.set(key, entry); // Reserve before awaiting launch: concurrent starts cannot duplicate.
    try {
      entry.child = await launch();
      entry.view.state = 'running';
      void entry.child.exited.then(result => {
        entry.view.state = 'exited';
        entry.view.exitCode = result.code;
      }, () => { entry.view.state = 'failed'; });
      return { ...entry.view };
    } catch (error) {
      entry.view.state = 'failed';
      throw error;
    } finally { release(); }
  }
  async stop(projectId: string, serviceId: string): Promise<void> {
    const entry = this.entries.get(this.key(projectId, serviceId));
    if (!entry) return;
    if (!entry.stop) entry.stop = this.stopEntry(entry);
    return entry.stop;
  }
  private async stopEntry(entry: Entry): Promise<void> {
    await entry.ready;
    if (!entry.child || ['exited', 'failed'].includes(entry.view.state)) return;
    entry.view.state = 'stopping';
    entry.child.terminate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        entry.child.exited.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.graceMs); }),
      ]);
      if (!exited) {
        // Never schedule a blind delayed PID kill: the owned handle is consulted at call time.
        entry.child.kill();
        await entry.child.exited;
      }
    } finally { if (timer) clearTimeout(timer); }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.entries.values()].map(entry => this.stop(entry.view.projectId, entry.view.serviceId)));
  }
}
