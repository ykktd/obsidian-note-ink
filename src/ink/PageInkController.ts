import { isMobileInkEnvironment } from "../utils/platform";
import { InkEngine } from "./InkEngine";
import { StrokeHistory, strokeChange, applyStrokeChange, sameStroke, type StrokeChange } from "./StrokeHistory";
import type { InkController } from "./InkController";
import type { InkStroke, InkToolState } from "./types";

const DEFAULT_TOOL_STATE: InkToolState = {
  tool: "pen",
  color: "#111111",
  width: 2,
  highlighterColor: "#ffd54a",
  highlighterWidth: 14,
  eraserRadius: 18,
  acceptTouchInput: false
};
const HISTORY_STACK_LIMIT = 40;

export type PageInkDescriptor = {
  pageNumber: number;
  pageEl: HTMLElement;
  width: number;
  height: number;
  offsetY: number;
  inputTop?: number;
  inputBottom?: number;
};

type PageInkRuntime = PageInkDescriptor & {
  committedCanvas: HTMLCanvasElement | null;
  liveCanvas: HTMLCanvasElement | null;
  engine: InkEngine | null;
};

export type PageInkControllerOptions = {
  scrollEl: HTMLElement;
  initialToolState?: Partial<InkToolState>;
  onChange: () => void;
  onInputStart?: () => void;
  onInputEnd?: () => void;
  recoverPointerOnMove?: boolean;
  panOutsideCanvas?: boolean;
  keepMarginPx?: number;
  releaseMarginPx?: number;
  getVisibleRange?: () => { top: number; bottom: number };
};

export class PageInkController implements InkController {
  private pages: PageInkRuntime[];
  private readonly pageStrokes = new Map<number, InkStroke[]>();
  private toolState: InkToolState;
  private inputEnabled = true;
  private history = new StrokeHistory();
  private strokes: InkStroke[] = [];
  private canvasPixelBudget = 4_000_000;
  private applying = false;
  private visibleRaf: number | null = null;
  private displayScale = 1;
  private pageObserver: IntersectionObserver | null = null;
  private observedNearPages = new Set<number>();

  constructor(
    pages: PageInkDescriptor[],
    private readonly options: PageInkControllerOptions
  ) {
    this.pages = pages.map((page) => ({
      ...page,
      committedCanvas: null,
      liveCanvas: null,
      engine: null
    }));
    this.toolState = { ...DEFAULT_TOOL_STATE, ...options.initialToolState };

    this.options.scrollEl.addEventListener("scroll", this.onScroll, { passive: true });
    this.attachPageObserver();
    this.queueVisibleRefresh();
  }

  destroy(): void {
    this.options.scrollEl.removeEventListener("scroll", this.onScroll);
    this.detachPageObserver();
    if (this.visibleRaf !== null) {
      cancelAnimationFrame(this.visibleRaf);
      this.visibleRaf = null;
    }

    for (const page of this.pages) {
      this.releasePageEngine(page);
    }
  }

  resize(_width: number, _height: number): void {
    this.queueVisibleRefresh();
  }

  /** Dynamically add new page tile descriptors (used when adding a new page in standalone multi-page notes) */
  addPageDescriptors(descriptors: PageInkDescriptor[]): void {
    for (const desc of descriptors) {
      const runtime: PageInkRuntime = { ...desc, committedCanvas: null, liveCanvas: null, engine: null };
      this.pages.push(runtime);
    }
    this.attachPageObserver();
    this.queueVisibleRefresh();
  }

  setDisplayScale(scale: number): void {
    const next = Math.max(1, Math.min(4, Number.isFinite(scale) ? scale : 1));
    if (Math.abs(next - this.displayScale) < 0.05) return;

    this.displayScale = next;
    for (const page of this.pages) {
      page.engine?.setDisplayScale(next);
    }
    this.queueVisibleRefresh();
  }

  loadStrokes(strokes:InkStroke[]):void {
    this.strokes=cloneStrokes(strokes);
    this.applyGlobalStrokes(this.strokes);this.history.reset();this.queueVisibleRefresh();
  }
  replaceStrokes(strokes:InkStroke[],notify=true,undoSnapshot?:InkStroke[]):void {
    this.flushPendingStrokes();
    const next=cloneStrokes(strokes),change=strokeChange(undoSnapshot ?? this.strokes,next);
    if(notify)this.history.record(change);
    this.strokes=next;
    this.updateChangedPages(change);
    if(notify)this.options.onChange();
  }
  getStrokes():InkStroke[] {return cloneStrokes(this.strokes);}
  flushPendingStrokes():void {for(const page of this.pages)page.engine?.flushPendingStrokes();}
  canUndo():boolean {return this.history.canUndo;}
  canRedo():boolean {return this.history.canRedo;}
  isInputActive():boolean {return this.pages.some(p=>p.engine?.isInputActive());}

  setToolState(patch: Partial<InkToolState>): void {
    this.toolState = { ...this.toolState, ...patch };
    for (const page of this.pages) {
      page.engine?.setToolState(patch);
    }
  }

  getToolState(): InkToolState {
    return { ...this.toolState };
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    for (const page of this.pages) {
      page.engine?.setInputEnabled(enabled);
    }
  }

  undo():void {
    this.flushPendingStrokes();const change=this.history.undo();if(!change)return;
    this.strokes=applyStrokeChange(this.strokes,change,false);
    this.updateChangedPages({removed:change.added,added:change.removed});this.options.onChange();
  }
  redo():void {
    this.flushPendingStrokes();const change=this.history.redo();if(!change)return;
    this.strokes=applyStrokeChange(this.strokes,change);
    this.updateChangedPages(change);this.options.onChange();
  }
  clear():void {this.replaceStrokes([]);}

  private onScroll = (): void => {
    this.queueVisibleRefresh();
  };

  private queueVisibleRefresh(): void {
    if (this.visibleRaf !== null) return;
    this.visibleRaf = requestAnimationFrame(() => {
      this.visibleRaf = null;
      this.refreshVisiblePages();
    });
  }

  private refreshVisiblePages(): void {
    if (this.pages.length === 0) return;

    const mobile = isMobileInkEnvironment();
    const keepMargin = this.options.keepMarginPx ?? (mobile
      ? Math.max(this.options.scrollEl.clientHeight * 0.85, 420)
      : Math.max(this.options.scrollEl.clientHeight * 1.8, 820));
    const releaseMargin = this.options.releaseMarginPx ?? keepMargin * (mobile ? 1.45 : 1.65);
    const visibleRange = this.options.getVisibleRange?.();
    const useObservedPages = this.observedNearPages.size > 0;

    const wanted=this.pages.filter(page=>{
      const near=useObservedPages ? this.observedNearPages.has(page.pageNumber) : visibleRange
        ? page.offsetY+page.height>=visibleRange.top-keepMargin && page.offsetY<=visibleRange.bottom+keepMargin
        : this.isPageNearViewport(page,keepMargin);
      const far=useObservedPages ? !this.observedNearPages.has(page.pageNumber) : visibleRange
        ? page.offsetY+page.height<visibleRange.top-releaseMargin || page.offsetY>visibleRange.bottom+releaseMargin
        : this.isPageFarFromViewport(page,releaseMargin);
      return near || (page.engine!==null && (!far || page.engine.isInputActive()));
    });
    for(const page of this.pages)if(!wanted.includes(page))this.releasePageEngine(page);
    // Reserve two layers per engine before mounting new pages. Canvas dimensions are rounded down.
    this.canvasPixelBudget=Math.min(mobile ? 4_000_000 : 8_000_000,Math.floor((mobile ? 16_000_000 : 48_000_000)/Math.max(2,wanted.length*2)));
    for(const page of wanted)page.engine?.setCanvasPixelBudget(this.canvasPixelBudget);
    for(const page of wanted)this.ensurePageEngine(page);
  }

  private attachPageObserver(): void {
    if (typeof IntersectionObserver === "undefined" || this.pages.length === 0) return;

    const mobile = isMobileInkEnvironment();
    const margin = Math.round(this.options.releaseMarginPx ?? (mobile
      ? Math.max(this.options.scrollEl.clientHeight * 0.9, 520)
      : Math.max(this.options.scrollEl.clientHeight * 1.7, 900)));
    this.pageObserver = new IntersectionObserver(this.onPageIntersection, {
      root: this.options.scrollEl,
      rootMargin: `${margin}px 0px ${margin}px 0px`,
      threshold: 0
    });

    for (const page of this.pages) {
      this.pageObserver.observe(page.pageEl);
    }
  }

  private detachPageObserver(): void {
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    this.observedNearPages.clear();
  }

  private onPageIntersection = (entries: IntersectionObserverEntry[]): void => {
    let changed = false;

    for (const entry of entries) {
      const page = this.pages.find((candidate) => candidate.pageEl === entry.target);
      if (!page) continue;

      if (entry.isIntersecting) {
        if (!this.observedNearPages.has(page.pageNumber)) {
          this.observedNearPages.add(page.pageNumber);
          changed = true;
        }
        continue;
      }

      if (this.observedNearPages.delete(page.pageNumber)) {
        changed = true;
      }
      if(!page.engine?.isInputActive())this.releasePageEngine(page);
    }

    if (changed) {
      this.queueVisibleRefresh();
    }
  };

  private isPageNearViewport(page: PageInkRuntime, margin: number): boolean {
    const scrollRect = this.options.scrollEl.getBoundingClientRect();
    const rect = page.pageEl.getBoundingClientRect();
    return rect.bottom >= scrollRect.top - margin && rect.top <= scrollRect.bottom + margin;
  }

  private isPageFarFromViewport(page: PageInkRuntime, margin: number): boolean {
    const scrollRect = this.options.scrollEl.getBoundingClientRect();
    const rect = page.pageEl.getBoundingClientRect();
    return rect.bottom < scrollRect.top - margin || rect.top > scrollRect.bottom + margin;
  }

  private ensurePageEngine(page: PageInkRuntime): void {
    if (page.engine) return;

    const committedCanvas = document.createElement("canvas");
    committedCanvas.className = "mobile-ink-committed-canvas mobile-ink-pdf-ink-canvas";
    committedCanvas.setAttribute("aria-hidden", "true");
    const liveCanvas = document.createElement("canvas");
    liveCanvas.className = "mobile-ink-live-canvas mobile-ink-pdf-ink-canvas";
    liveCanvas.setAttribute("aria-label", `PDF page ${page.pageNumber} handwriting layer`);

    page.pageEl.appendChild(committedCanvas);
    page.pageEl.appendChild(liveCanvas);

    const engine = new InkEngine(liveCanvas, committedCanvas, this.options.scrollEl, {
      initialToolState: this.toolState,
      canvasMaxDpr: this.getInkCanvasMaxDpr(),
      canvasMaxPixels: this.canvasPixelBudget,
      externalHistory: true,
      inputBounds: Number.isFinite(page.inputTop) && Number.isFinite(page.inputBottom)
        ? { top: page.inputTop ?? 0, bottom: page.inputBottom ?? page.height }
        : undefined,
      recoverPointerOnMove: false,
      panOutsideCanvas: this.options.panOutsideCanvas,
      onInputStart: this.options.onInputStart,
      onInputEnd: () => this.handlePageInputEnd(page),
      onChange: () => this.handlePageChange(page)
    });
    engine.resize(page.width, page.height);
    engine.setDisplayScale(this.displayScale);
    engine.setInputEnabled(this.inputEnabled);
    engine.loadStrokes(this.pageStrokes.get(page.pageNumber) ?? []);
    this.pageStrokes.set(page.pageNumber,[...engine.getStrokeRefs()]);

    page.committedCanvas = committedCanvas;
    page.liveCanvas = liveCanvas;
    page.engine = engine;
  }

  private releasePageEngine(page: PageInkRuntime): void {
    if (!page.engine) return;

    page.engine.flushPendingStrokes();
    page.engine.destroy();
    if(page.committedCanvas)page.committedCanvas.width=page.committedCanvas.height=0;
    if(page.liveCanvas)page.liveCanvas.width=page.liveCanvas.height=0;
    page.engine = null;
    page.committedCanvas?.remove();
    page.liveCanvas?.remove();
    page.committedCanvas = null;
    page.liveCanvas = null;
  }

  private handlePageChange(page:PageInkRuntime):void {
    if(this.applying || !page.engine)return;
    const before=this.pageStrokes.get(page.pageNumber) ?? [];
    const after=page.engine.getStrokeRefs();
    const local=strokeChange(before,after);
    if(!local.removed.length && !local.added.length)return;
    const global:StrokeChange={
      removed:local.removed.flatMap(({stroke})=>{const index=this.strokes.findIndex(s=>s.id===stroke.id);return index<0 ? [] : [{index,stroke:this.strokes[index]}];}),
      added:local.added.map(({stroke})=>{
        const index=this.strokes.findIndex(s=>s.id===stroke.id);
        return {index:index<0 ? this.strokes.length : index,stroke:{...stroke,points:stroke.points.map(p=>({...p,y:p.y+page.offsetY}))}};
      })
    };
    // New strokes share local point arrays with the originating engine. Only changed geometry is converted.
    this.strokes=applyStrokeChange(this.strokes,global);
    this.history.record(global);
    this.pageStrokes.set(page.pageNumber,[...after]);
    this.updateChangedPages(global,page);
    this.options.onChange();
  }
  private handlePageInputEnd(_page:PageInkRuntime):void {
    this.options.onInputEnd?.();this.queueVisibleRefresh();
  }
  private updateChangedPages(change:StrokeChange,source?:PageInkRuntime):void {
    const affected=new Set<number>();
    for(const {stroke} of [...change.removed,...change.added])for(const p of this.pagesForStroke(stroke))affected.add(p.pageNumber);
    const ids=new Set([...change.removed,...change.added].map(e=>e.stroke.id));
    this.applying=true;
    try {for(const page of this.pages){
      if(!affected.has(page.pageNumber) || page===source)continue;
      const before=this.pageStrokes.get(page.pageNumber) ?? [];
      const next=before.filter(s=>!ids.has(s.id));
      for(const {stroke} of change.added)if(this.pagesForStroke(stroke).includes(page))next.push(this.toLocal(stroke,page));
      // Preserve document order for overlapping translucent strokes.
      const order=new Map(this.strokes.map((s,i)=>[s.id,i]));next.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0));
      this.pageStrokes.set(page.pageNumber,next);
      if(before.length!==next.length || before.some((s,i)=>!sameStroke(s,next[i]))){page.engine?.replaceStrokes(next,false);
        if(page.engine)this.pageStrokes.set(page.pageNumber,[...page.engine.getStrokeRefs()]);}
    }} finally {this.applying=false;}
  }
  private pagesForStroke(stroke:InkStroke):PageInkRuntime[] {
    const bounds=getStrokeBounds(stroke);if(!bounds)return [];
    const pad=stroke.width;
    return this.pages.filter(p=>bounds.y+bounds.height+pad>=p.offsetY && bounds.y-pad<=p.offsetY+p.height);
  }
  private toLocal(stroke:InkStroke,page:PageInkRuntime):InkStroke {
    return {...stroke,points:stroke.points.map(p=>({...p,y:p.y-page.offsetY}))};
  }

  private applyGlobalStrokes(strokes: InkStroke[]): void {
    const grouped = this.splitStrokesByPage(strokes);

    this.applying = true;
    try {
      for (const page of this.pages) {
        const localStrokes = grouped.get(page.pageNumber) ?? [];
        this.pageStrokes.set(page.pageNumber, localStrokes);
        page.engine?.replaceStrokes(localStrokes, false);
        if(page.engine)this.pageStrokes.set(page.pageNumber,[...page.engine.getStrokeRefs()]);
      }
    } finally {
      this.applying = false;
    }
  }

  private splitStrokesByPage(strokes:InkStroke[]):Map<number,InkStroke[]> {
    const grouped=new Map<number,InkStroke[]>();
    for(const stroke of strokes)for(const page of this.pagesForStroke(stroke)) {
      const list=grouped.get(page.pageNumber) ?? [];list.push(this.toLocal(stroke,page));grouped.set(page.pageNumber,list);
    }
    return grouped;
  }
  private getInkCanvasMaxDpr():number {return isMobileInkEnvironment() ? 3 : 3.75;}

}

function cloneStrokes(strokes: InkStroke[]): InkStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point }))
  }));
}

function getStrokeBounds(stroke: InkStroke): { y: number; height: number } | null {
  if (stroke.points.length === 0) return null;

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of stroke.points) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return {
    y: minY,
    height: Math.max(0, maxY - minY)
  };
}

function strokesEqual(a: InkStroke[], b: InkStroke[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left.id !== right.id
      || left.tool !== right.tool
      || left.color !== right.color
      || left.width !== right.width
      || left.points.length !== right.points.length) {
      return false;
    }

    for (let j = 0; j < left.points.length; j++) {
      const lp = left.points[j];
      const rp = right.points[j];
      if (lp.x !== rp.x
        || lp.y !== rp.y
        || lp.t !== rp.t
        || lp.pressure !== rp.pressure
        || lp.tiltX !== rp.tiltX
        || lp.tiltY !== rp.tiltY) {
        return false;
      }
    }
  }

  return true;
}
