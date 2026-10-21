import { describe, it, expect } from 'vitest';
import { ImmediateSteering } from './immediate-steering.js';

describe('ImmediateSteering', () => {
  it('interrupts generation and resumes once without ending the root run', async () => {
    const steering = new ImmediateSteering();
    let release!: () => void;
    let resumed = 0;
    const run = steering.run(() => new Promise<void>(r => { release = r; }), async () => { resumed++; }, () => false);
    steering.request(async () => { release(); }, () => false);
    steering.request(async () => { throw new Error('duplicate abort'); }, () => false);
    await run;
    expect(resumed).toBe(1);
    expect(steering.interrupting).toBe(false);
  });
  it('does not interrupt active tools', () => {
    const steering = new ImmediateSteering();
    steering.toolStarted();
    steering.request(async () => { throw new Error('tool cancelled'); }, () => false);
    expect(steering.interrupting).toBe(false);
    steering.toolEnded();
    steering.request(async () => {}, () => false);
    expect(steering.interrupting).toBe(true);
  });
  it('lets user stop win over steering', async () => {
    const steering = new ImmediateSteering();
    let stopped = false;
    let resumed = false;
    await steering.run(async () => {
      steering.request(async () => {}, () => stopped);
      stopped = true;
    }, async () => { resumed = true; }, () => stopped);
    expect(resumed).toBe(false);
  });
  it('continues after an intentional abort rejection but preserves real failures', async () => {
    const steering = new ImmediateSteering();
    let resumed = false;
    await steering.run(async () => {
      steering.request(async () => {}, () => false);
      throw new Error('aborted');
    }, async () => { resumed = true; }, () => false);
    expect(resumed).toBe(true);
    await expect(new ImmediateSteering().run(async () => { throw new Error('provider'); }, async () => {}, () => false)).rejects.toThrow('provider');
  });
});
