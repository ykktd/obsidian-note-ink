import type { NativePageView, NativeViewer } from './NativePdfViewer';

type Pinch = {
  ids: number[];
  distance: number;
  scale: number;
  page: NativePageView;
  x: number;
  y: number;
};

/** Keep the same point on the same page under the fingers throughout a pinch. */
export class NativePdfPinchZoom {
  private pinch: Pinch | null = null;
  private readonly doc: Document;
  private overflowAnchor = '';
  private overflowAnchorPriority = '';

  constructor(private viewer: NativeViewer, private onStart: () => void, private onEnd: () => void) {
    this.doc = viewer.container.ownerDocument;
    // Capture before the native viewer's touch handler so it cannot apply a second zoom.
    this.doc.addEventListener('touchstart', this.start, { capture: true, passive: false });
    this.doc.addEventListener('touchmove', this.move, { capture: true, passive: false });
    this.doc.addEventListener('touchend', this.end, true);
    this.doc.addEventListener('touchcancel', this.end, true);
    this.doc.defaultView?.addEventListener('blur', this.finish);
  }

  destroy(): void {
    this.finish();
    this.doc.removeEventListener('touchstart', this.start, true);
    this.doc.removeEventListener('touchmove', this.move, true);
    this.doc.removeEventListener('touchend', this.end, true);
    this.doc.removeEventListener('touchcancel', this.end, true);
    this.doc.defaultView?.removeEventListener('blur', this.finish);
  }

  private fingers(event: TouchEvent): Touch[] {
    return Array.from(event.touches).filter(touch =>
      (touch as Touch & { touchType?: string }).touchType !== 'stylus' &&
      this.viewer.container.contains(touch.target as Node));
  }

  private consume(event: TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  private start = (event: TouchEvent): void => {
    if (this.pinch) { this.consume(event); return; }
    const touches = this.fingers(event);
    if (touches.length !== 2) return;
    const [a, b] = touches;
    const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    if (!distance) return;
    const x = (a.clientX + b.clientX) / 2, y = (a.clientY + b.clientY) / 2;
    // Include page gaps: select the nearest page, preserving the relative point
    // outside its bounds as well. Page margins do not scale with the PDF.
    let page: NativePageView | undefined, best = Infinity;
    for (let i = 0; i < this.viewer.pagesCount; i++) {
      const candidate = this.viewer.getPageView(i), r = candidate.div.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (d < best) { best = d; page = candidate; }
      if (!d) break;
    }
    if (!page) return;
    const rect = page.div.getBoundingClientRect();
    this.pinch = { ids: touches.map(t => t.identifier), distance, scale: this.viewer.currentScale,
      page, x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
    const style = this.viewer.container.style;
    this.overflowAnchor = style.getPropertyValue('overflow-anchor');
    this.overflowAnchorPriority = style.getPropertyPriority('overflow-anchor');
    style.setProperty('overflow-anchor', 'none');
    this.onStart();
    this.consume(event);
  };

  private move = (event: TouchEvent): void => {
    const pinch = this.pinch;
    if (!pinch) return;
    const touches = this.fingers(event);
    const [a, b] = pinch.ids.map(id => touches.find(t => t.identifier === id));
    if (!a || !b) { this.finish(); return; }
    this.consume(event);
    const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    if (!distance) return;
    const scale = Math.max(.1, Math.min(10, pinch.scale * distance / pinch.distance));
    if (this.viewer.updateScale) {
      this.viewer.updateScale({ scaleFactor: scale / this.viewer.currentScale, drawingDelay: 150 });
    } else {
      this.viewer.currentScale = scale;
    }
    // Read the actual page geometry after native layout (including centering,
    // rotation, mixed page sizes and fixed page gaps), then correct the scroll.
    const rect = pinch.page.div.getBoundingClientRect();
    this.viewer.container.scrollLeft += rect.left + pinch.x * rect.width - (a.clientX + b.clientX) / 2;
    this.viewer.container.scrollTop += rect.top + pinch.y * rect.height - (a.clientY + b.clientY) / 2;
  };

  private end = (event: TouchEvent): void => {
    if (!this.pinch) return;
    const touches = this.fingers(event);
    if (event.type === 'touchcancel' || this.pinch.ids.some(id => !touches.some(t => t.identifier === id))) this.finish();
  };

  private finish = (): void => {
    if (!this.pinch) return;
    this.pinch = null;
    const style = this.viewer.container.style;
    if (this.overflowAnchor) style.setProperty('overflow-anchor', this.overflowAnchor, this.overflowAnchorPriority);
    else style.removeProperty('overflow-anchor');
    this.onEnd();
  };
}
