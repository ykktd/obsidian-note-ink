export class SaveQueue {
  private timer: number | null = null;
  private dirty = false;
  private pending: Promise<void> | null = null;
  private paused = false;

  constructor(
    private readonly saveFn: () => Promise<void>,
    private readonly debounceMs = 800,
    private readonly onError: (error: unknown) => void = error => console.error('Note Ink: failed to save',error),
    private readonly onSaved: () => void = () => {},
  ) {}

  setPaused(paused:boolean):void {
    this.paused=paused;
    if(this.timer!==null){window.clearTimeout(this.timer);this.timer=null;}
    if(!paused && this.dirty)this.schedule();
  }
  markDirty():void {this.dirty=true;if(!this.paused)this.schedule();}
  private schedule():void {
    if(this.timer!==null)window.clearTimeout(this.timer);
    this.timer=window.setTimeout(()=>{this.timer=null;if(!this.paused)void this.flush(false).catch(()=>{});},this.debounceMs);
  }

  async flush(force = true): Promise<void> {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    // A manual save/export/close must wait for a currently running autosave.
    if (this.pending) await this.pending;
    while (this.dirty && (force || !this.paused)) {
      this.dirty = false;
      const task = Promise.resolve().then(() => this.saveFn());
      this.pending = task;
      try { await task; this.onSaved(); }
      catch (error) {
        this.dirty = true;
        this.onError(error);
        throw error;
      } finally { if (this.pending === task) this.pending = null; }
    }
  }
}
