type EraserMode = "idle" | "press" | "hold" | "once";

/** A short press arms one erase gesture; a held press is a temporary modifier. */
export class QuickEraserControl {
  private mode: EraserMode = "idle";
  private pointerId: number | null = null;
  private timer: number | null = null;
  private usedDuringPress = false;
  private restoreTool: (() => void) | null = null;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly label: HTMLElement,
    private readonly activate: () => (() => void) | null
  ) {
    button.addEventListener("pointerdown", this.onPointerDown);
    button.addEventListener("lostpointercapture", this.onPointerCancel);
    button.addEventListener("click", this.onClick);
    button.addEventListener("contextmenu", this.blockTouch);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      button.addEventListener(type, this.blockTouch, { passive: false });
    }
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerCancel, true);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.updateState();
  }

  get active(): boolean { return this.mode !== "idle"; }

  inputEnded(): void {
    if (this.mode === "once") this.cancel();
    else if (this.mode === "press") this.usedDuringPress = true;
  }

  cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const id = this.pointerId;
    this.pointerId = null;
    this.mode = "idle";
    this.updateState();
    const restore = this.restoreTool;
    this.restoreTool = null;
    // Clear our state first: flushing an unfinished erase gesture calls inputEnded().
    restore?.();
    if (id !== null) {
      try { this.button.releasePointerCapture(id); } catch { /* Already released. */ }
    }
  }

  destroy(): void {
    this.cancel();
    this.button.removeEventListener("pointerdown", this.onPointerDown);
    this.button.removeEventListener("lostpointercapture", this.onPointerCancel);
    this.button.removeEventListener("click", this.onClick);
    this.button.removeEventListener("contextmenu", this.blockTouch);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      this.button.removeEventListener(type, this.blockTouch);
    }
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("pointercancel", this.onPointerCancel, true);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private begin(): boolean {
    this.cancel();
    this.restoreTool = this.activate();
    return this.restoreTool !== null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.pointerId !== null || event.button !== 0 || this.button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    // A second tap cancels an armed one-time eraser.
    if (this.mode === "once") { this.cancel(); return; }
    if (!this.begin()) return;
    this.pointerId = event.pointerId;
    this.usedDuringPress = false;
    this.mode = "press";
    this.updateState();
    try { this.button.setPointerCapture(event.pointerId); } catch { /* Window listeners also handle release. */ }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.mode = "hold";
      this.updateState();
    }, 280);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.mode === "hold" || this.usedDuringPress) { this.cancel(); return; }
    this.pointerId = null;
    this.mode = "once";
    this.updateState();
    try { this.button.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === event.pointerId) this.cancel();
  };
  private onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    // Pointer presses are handled above; native keyboard/assistive activation uses detail 0.
    if (event.detail !== 0) return;
    if (this.active) this.cancel();
    else if (this.begin()) { this.mode = "once"; this.updateState(); }
  };
  private blockTouch = (event: Event): void => {
    // touch-action:none handles scrolling. Preventing touchstart cancels Pencil/
    // finger pointer streams in WebKit, so only block the native context menu.
    if (event.type === "contextmenu") event.preventDefault();
    event.stopPropagation();
  };
  private onBlur = (): void => this.cancel();
  private onVisibilityChange = (): void => { if (document.hidden) this.cancel(); };

  private updateState(): void {
    const text = this.mode === "idle" ? "一時消しゴム" : this.mode === "once" ? "一度だけ消す" : "離すとペン";
    this.label.textContent = text;
    this.button.dataset.mode = this.mode;
    this.button.setAttribute("aria-pressed", String(this.active));
    this.button.setAttribute("aria-label", `${text}：タップで一度だけ消す、長押ししている間だけ消す`);
    this.button.title = "タップ：一度だけ消す／長押し：押している間だけ消す";
  }
}
