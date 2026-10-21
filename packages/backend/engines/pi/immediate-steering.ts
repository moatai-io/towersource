/** Interrupt generation only; never cancel a tool with potentially committed side effects. */
export class ImmediateSteering {
  private requested = false;
  private tools = 0;
  toolStarted(): void { this.tools++; }
  toolEnded(): void { this.tools = Math.max(0, this.tools - 1); }
  get interrupting(): boolean { return this.requested; }
  request(abort: () => Promise<void>, cancelled: () => boolean): void {
    if (this.tools || this.requested || cancelled()) return;
    this.requested = true;
    // SDK abort waits for idle. Do not wait here: the owning prompt loop resumes.
    void abort().catch(() => { /* owning prompt handles settlement */ });
  }
  async run(start: () => Promise<void>, resume: () => Promise<void>, cancelled: () => boolean): Promise<void> {
    let next = start;
    for (;;) {
      try { await next(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.requested || cancelled() || !/abort/i.test(message)) throw error;
      }
      if (!this.requested || cancelled()) return;
      this.requested = false;
      next = resume;
    }
  }
}
