import { setIcon } from 'obsidian';

/** Positions only the toolbar; PDF scroll, zoom, and the current tool are untouched. */
export class FloatingInkToolbar {
  private readonly win: Window;
  private readonly shell: HTMLDivElement;
  private readonly grip: HTMLButtonElement;
  private readonly minimize: HTMLButtonElement;
  private readonly restore: HTMLButtonElement;
  private readonly observer: ResizeObserver;
  private x: number | null = null;
  private y: number | null = null;
  private minimized = false;
  private panelRequested = false;
  private disposed = false;
  private frame: number | null = null;
  private drag: { id: number; startX: number; startY: number; x: number; y: number; moved: boolean; target: HTMLButtonElement } | null = null;
  private suppressRestoreClick = false;

  constructor(private host: HTMLElement, private root: HTMLElement, private dock: HTMLElement,
    private panel: HTMLElement, private anchor: HTMLElement) {
    this.win = host.ownerDocument.defaultView!;
    const doc = host.ownerDocument;
    const button = (label: string, icon: string) => {
      const b = doc.createElement('button'); b.type = 'button'; b.className = 'mobile-ink-icon-button';
      b.setAttribute('aria-label', label); b.title = label; setIcon(b, icon); return b;
    };
    this.grip = button('ツールバーを移動', 'grip-vertical');
    this.grip.classList.add('note-ink-toolbar-grip');
    this.grip.title = 'ドラッグで移動・矢印キーでも移動';
    this.minimize = button('ツールバーを最小化', 'minus');
    this.restore = button('注釈ツールバーを開く', 'panel-top-open');
    this.restore.classList.add('note-ink-toolbar-restore'); this.restore.hidden = true;
    this.shell = doc.createElement('div'); this.shell.className = 'note-ink-toolbar-shell';
    this.shell.append(this.grip, dock, this.minimize); root.prepend(this.shell); root.append(this.restore);
    this.minimize.addEventListener('click', this.collapse);
    this.restore.addEventListener('click', this.expand);
    for (const handle of [this.grip, this.restore]) {
      handle.addEventListener('pointerdown', this.startDrag);
      handle.addEventListener('keydown', this.moveWithKeyboard);
    }
    this.win.addEventListener('pointermove', this.moveDrag, true);
    this.win.addEventListener('pointerup', this.endDrag, true);
    this.win.addEventListener('pointercancel', this.endDrag, true);
    this.win.addEventListener('blur', this.cancelDrag);
    this.win.addEventListener('resize', this.schedule);
    this.win.visualViewport?.addEventListener('resize', this.schedule);
    this.win.visualViewport?.addEventListener('scroll', this.schedule);
    dock.addEventListener('scroll', this.schedule, {passive: true});
    this.observer = new ResizeObserver(this.schedule);
    for (const el of [host, this.shell, panel]) this.observer.observe(el);
    this.layout();
  }

  setPanelVisible(visible: boolean): void {
    this.panelRequested = visible;
    this.layout();
  }

  destroy(): void {
    this.disposed = true; this.cancelDrag(); this.observer.disconnect();
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.win.removeEventListener('pointermove', this.moveDrag, true);
    this.win.removeEventListener('pointerup', this.endDrag, true);
    this.win.removeEventListener('pointercancel', this.endDrag, true);
    this.win.removeEventListener('blur', this.cancelDrag);
    this.win.removeEventListener('resize', this.schedule);
    this.win.visualViewport?.removeEventListener('resize', this.schedule);
    this.win.visualViewport?.removeEventListener('scroll', this.schedule);
    this.dock.removeEventListener('scroll', this.schedule);
  }

  private schedule = (): void => {
    if (this.disposed || this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => { this.frame = null; this.layout(); });
  };

  private bounds() {
    const r = this.host.getBoundingClientRect(), v = this.win.visualViewport;
    const left = Math.max(r.left, v?.offsetLeft ?? 0), top = Math.max(r.top, v?.offsetTop ?? 0);
    const right = Math.min(r.right, (v?.offsetLeft ?? 0) + (v?.width ?? this.win.innerWidth));
    const bottom = Math.min(r.bottom, (v?.offsetTop ?? 0) + (v?.height ?? this.win.innerHeight));
    return {left: left-r.left+8, top: top-r.top+8, right: right-r.left-8, bottom: bottom-r.top-8, host: r};
  }

  private layout(): void {
    if (this.disposed || !this.host.isConnected) return;
    const b = this.bounds(), width = Math.max(1, b.right-b.left), height = Math.max(1, b.bottom-b.top);
    this.root.style.maxWidth = `${width}px`;
    const w = this.root.offsetWidth, h = this.root.offsetHeight;
    this.x = clamp(this.x ?? b.left+(width-w)/2, b.left, b.right-w);
    this.y = clamp(this.y ?? b.bottom-h-8, b.top, b.bottom-h);
    this.root.style.left = `${this.x}px`; this.root.style.top = `${this.y}px`;
    this.panel.hidden = !this.panelRequested || this.minimized;
    if (this.panel.hidden) return;

    const a = this.anchor.getBoundingClientRect(), d = this.dock.getBoundingClientRect();
    // If the user scrolls the tool strip away from the eraser, do not leave an orphaned panel.
    if (a.right <= d.left || a.left >= d.right) { this.panel.hidden = true; return; }
    this.panel.style.maxWidth = `${width}px`;
    this.panel.style.maxHeight = `${height}px`;
    const ph = this.panel.offsetHeight, pw = this.panel.offsetWidth;
    const above = Math.max(0, this.y-b.top-8), below = Math.max(0, b.bottom-this.y-h-8);
    let down = this.y+h/2 < b.top+height/2;
    if ((down ? below : above) < ph && (down ? above : below) >= ph) down = !down;
    else if (above < ph && below < ph) down = below >= above;
    const available = down ? below : above;
    this.panel.style.maxHeight = `${available}px`;
    const center = (Math.max(a.left,d.left)+Math.min(a.right,d.right))/2-b.host.left;
    this.panel.style.left = `${clamp(center-pw/2,b.left,b.right-pw)-this.x}px`;
    this.panel.style.top = `${down ? h+8 : -this.panel.offsetHeight-8}px`;
    this.panel.dataset.side = down ? 'below' : 'above';
  }

  private collapse = (): void => {
    this.minimized = true; this.root.dataset.minimized = 'true';
    this.shell.hidden = true; this.restore.hidden = false;
    this.layout(); this.restore.focus({preventScroll: true});
  };
  private expand = (event: MouseEvent): void => {
    if (this.suppressRestoreClick && event.detail !== 0) { this.suppressRestoreClick = false; return; }
    this.suppressRestoreClick = false;
    this.minimized = false; delete this.root.dataset.minimized;
    this.shell.hidden = false; this.restore.hidden = true;
    this.layout(); this.grip.focus({preventScroll: true});
  };
  private startDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drag) return;
    this.suppressRestoreClick = false;
    const target = event.currentTarget as HTMLButtonElement;
    this.drag = {id: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.x!, y: this.y!, moved: false, target};
    target.setPointerCapture(event.pointerId);
    // touch-action:none on these handles reserves dragging without blocking PDF gestures.
    event.stopPropagation();
  };
  private moveDrag = (event: PointerEvent): void => {
    const drag = this.drag; if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX-drag.startX, dy = event.clientY-drag.startY;
    if (!drag.moved && Math.hypot(dx,dy)<5) return;
    drag.moved = true; event.preventDefault(); event.stopPropagation();
    this.x = drag.x+dx; this.y = drag.y+dy; this.layout();
  };
  private endDrag = (event: PointerEvent): void => {
    if (this.drag?.id !== event.pointerId) return;
    this.suppressRestoreClick = this.drag.moved && this.drag.target === this.restore;
    this.cancelDrag();
  };
  private cancelDrag = (): void => {
    const drag = this.drag; this.drag = null;
    if (drag?.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id);
  };
  private moveWithKeyboard = (event: KeyboardEvent): void => {
    const delta: Record<string, [number, number]> = {ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1]};
    const d = delta[event.key]; if (!d) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    this.x = this.x!+d[0]*step; this.y = this.y!+d[1]*step; this.layout();
  };
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(value, Math.max(min,max))); }
