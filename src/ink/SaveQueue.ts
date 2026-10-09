export class SaveQueue {
  private timer: number | null = null;
  private dirty = false;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly saveFn: () => Promise<void>,
    private readonly debounceMs = 800,
    private readonly onError: (error: unknown) => void = error => console.error('Lecture Ink: failed to save',error),
  ) {}

  markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.flush().catch(()=>{}); }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    // A manual save/export/close must wait for a currently running autosave.
    if (this.pending) await this.pending;
    while (this.dirty) {
      this.dirty = false;
      const task = this.saveFn();
      this.pending = task;
      try { await task; }
      catch (error) {
        this.dirty = true;
        this.onError(error);
        throw error;
      } finally { if (this.pending === task) this.pending = null; }
    }
  }
}
