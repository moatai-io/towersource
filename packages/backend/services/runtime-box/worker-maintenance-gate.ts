import fs from 'node:fs';

/** Synchronous file-backed admission fence. The root lifecycle owner writes by atomic
 * rename+fsync. Missing/corrupt/unreadable state fails closed; no TTL unlocks a crash.
 * In-memory mode exists only for embedders/tests without installed maintenance. */
export class WorkerMaintenanceGate {
  private owner: string | null = null;
  private runs = 0;
  constructor(private readonly stateFile?: string) {}

  private diskOwner(): string | null {
    if (!this.stateFile) return null;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s.version !== 1 || !(s.owner === null || (typeof s.owner === 'string' && s.owner.length > 0))) return 'invalid-state';
      return s.owner;
    } catch { return 'unavailable-state'; }
  }
  snapshot() { return { draining: this.owner !== null || this.diskOwner() !== null, activeRequests: this.runs }; }

  acquire(owner: string): boolean {
    if (!owner || owner.length > 120) throw new Error('INVALID_MAINTENANCE_OWNER');
    if (this.stateFile || (this.owner !== null && this.owner !== owner)) return false;
    this.owner = owner;
    return true;
  }
  release(owner: string): boolean {
    if (this.stateFile || !owner || this.owner !== owner) return false;
    this.owner = null;
    return true;
  }
  owns(owner: string): boolean {
    return Boolean(owner) && !['invalid-state', 'unavailable-state'].includes(owner)
      && owner === (this.stateFile ? this.diskOwner() : this.owner);
  }
  enter(): (() => void) | null {
    if (this.snapshot().draining) return null;
    return this.count();
  }
  /** Fixed synthetic probe only. Never use this to admit caller-supplied commands. */
  enterProbe(owner: string): (() => void) | null { return this.owns(owner) ? this.count() : null; }
  private count(): () => void {
    this.runs++;
    let done = false;
    return () => { if (!done) { done = true; this.runs--; } };
  }
}
