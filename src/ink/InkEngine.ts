import { distanceSquared, drawStroke, drawStrokeSegment, drawStrokeTail, drawStrokes, setupCanvas } from "./renderer";
import { eraseStrokes } from "./eraser";
import { StrokeHistory, strokeChange, applyStrokeChange } from "./StrokeHistory";
import { InkEngineOptions, InkPoint, InkStroke, InkToolState } from "./types";

const DEFAULT_TOOL_STATE: InkToolState = {
  tool: "pen",
  color: "#111111",
  width: 2,
  highlighterColor: "#ffd54a",
  highlighterWidth: 14,
  eraserRadius: 18,
  acceptTouchInput: false
};

const MIN_POINT_DISTANCE_SQ = 0.35 * 0.35;
const MAX_POINT_GAP_MS = 120;
const CANCEL_GRACE_MS = 400;
const TOUCH_POINTER_SUPPRESSION_MS = 700;
const PEN_TOUCH_REJECTION_MS = 1200;
const MAX_PREDICTED_POINTS = 6;
const MAX_PREDICTED_EVENT_TIME_AHEAD_MS = 90;

type CanvasPointMapping = {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
};

export class InkEngine {
  private get eventDocument(): Document { return this.options.inputRoot?.ownerDocument ?? document; }
  private get touchEventTarget(): Window|Document { return this.options.nativeScroll ? this.eventDocument : window; }
  private committedCtx: CanvasRenderingContext2D;
  private liveCtx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private strokes: InkStroke[] = [];
  private history = new StrokeHistory();
  private eraserBefore: readonly InkStroke[] | null = null;
  private queuedStroke: InkStroke | null = null;
  private renderedPointCounts = new WeakMap<InkStroke,number>();
  private pendingPredictionEvent: PointerEvent | null = null;
  private liveTailBounds: {x:number;y:number;width:number;height:number} | null = null;
  private activeStroke: InkStroke | null = null;
  private activePointerId: number | null = null;
  private activeTouchId: number | null = null;
  private panPointerId: number | null = null;
  private lastPanClientX = 0;
  private lastPanClientY = 0;
  private liveRenderRaf: number | null = null;
  private committedRenderRaf: number | null = null;
  private cancelGraceTimer: number | null = null;
  private predictedStrokeRendered = false;
  private suppressTouchPointerUntil = 0;
  private suppressTouchPanUntil = 0;
  private debugMoveCounter = 0;
  private sampleTime = 0;
  private eraserChanged = false;
  private lastErasePoint: InkPoint | null = null;
  private inputEnabled = true;
  private displayScale = 1;
  private toolState: InkToolState = { ...DEFAULT_TOOL_STATE };

  constructor(
    private readonly liveCanvas: HTMLCanvasElement,
    private readonly committedCanvas: HTMLCanvasElement,
    private readonly scrollEl: HTMLElement,
    private readonly options: InkEngineOptions
  ) {
    this.toolState = { ...DEFAULT_TOOL_STATE, ...options.initialToolState };
    this.committedCtx = this.setupInkCanvas(committedCanvas, this.displayScale);
    this.liveCtx = this.setupInkCanvas(liveCanvas, this.displayScale);
    this.bindEvents();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.ceil(width));
    this.height = Math.max(1, Math.ceil(height));
    this.committedCtx = this.setupInkCanvas(this.committedCanvas, this.displayScale);
    this.liveCtx = this.setupInkCanvas(this.liveCanvas, this.displayScale);
    this.predictedStrokeRendered = false;
    this.renderCommittedNow();
  }

  setDisplayScale(scale: number): void {
    const next = Math.max(1, Math.min(4, Number.isFinite(scale) ? scale : 1));
    if (Math.abs(next - this.displayScale) < 0.05) return;

    this.displayScale = next;
    this.committedCtx = this.setupInkCanvas(this.committedCanvas, this.displayScale);
    this.liveCtx = this.setupInkCanvas(this.liveCanvas, this.displayScale);
    this.renderCommittedNow();
    this.renderLiveNow();
  }

  destroy(): void {
    this.liveCanvas.removeEventListener("pointermove", this.onPointerMove);
    this.liveCanvas.removeEventListener("pointerup", this.onPointerUp);
    this.liveCanvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.liveCanvas.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    this.touchEventTarget.removeEventListener("touchstart", this.onTouchStart as EventListener, true);
    this.touchEventTarget.removeEventListener("touchmove", this.onTouchMove as EventListener, true);
    this.touchEventTarget.removeEventListener("touchend", this.onTouchEnd as EventListener, true);
    this.touchEventTarget.removeEventListener("touchcancel", this.onTouchCancel as EventListener, true);
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    this.eventDocument.removeEventListener("pointerdown", this.onPointerDown, true);
    this.eventDocument.removeEventListener("pointermove", this.onPointerMove, true);
    this.eventDocument.removeEventListener("pointerup", this.onPointerUp, true);
    this.eventDocument.removeEventListener("pointercancel", this.onPointerCancel, true);
    this.eventDocument.removeEventListener("selectstart", this.onDocumentBlockedGesture, true);
    this.eventDocument.removeEventListener("dragstart", this.onDocumentBlockedGesture, true);
    this.eventDocument.removeEventListener("contextmenu", this.onDocumentBlockedGesture, true);
    this.eventDocument.removeEventListener("selectionchange", this.onDocumentSelectionChange);
    this.eventDocument.removeEventListener("pointerdown", this.onDocumentPointerProbe, true);
    this.eventDocument.removeEventListener("pointermove", this.onDocumentPointerProbe, true);

    if (this.liveRenderRaf !== null) cancelAnimationFrame(this.liveRenderRaf);
    if (this.committedRenderRaf !== null) cancelAnimationFrame(this.committedRenderRaf);
    this.clearCancelGraceTimer();
    this.finishInterruptedInput();
  }

  loadStrokes(strokes: InkStroke[]): void {
    this.strokes = cloneStrokes(strokes);
    this.history.reset();
    this.renderCommittedNow();
  }

  replaceStrokes(strokes: InkStroke[], notify = true, undoSnapshot?: InkStroke[]): void {
    this.clearCancelGraceTimer();
    this.finishInterruptedInput();
    const nextStrokes = cloneStrokes(strokes);
    if (notify) {
      if(!this.options.externalHistory)this.history.record(strokeChange(undoSnapshot ?? this.strokes,nextStrokes));
    }
    this.strokes = nextStrokes;
    this.activeStroke = null;
    this.renderCommittedNow();
    this.renderLiveNow();
    if (notify) {
      this.options.onChange();
    }
  }

  getStrokes(): InkStroke[] {
    return cloneStrokes(this.strokes);
  }

  flushPendingStrokes(): void {
    this.finishInterruptedInput();
  }

  /** Borrow immutable committed data; callers must not mutate it. */
  getStrokeRefs(): readonly InkStroke[] { return this.strokes; }
  canUndo(): boolean { return this.history.canUndo; }
  canRedo(): boolean { return this.history.canRedo; }
  isInputActive(): boolean { return this.activeStroke !== null || this.activePointerId !== null || this.activeTouchId !== null; }
  setCanvasPixelBudget(pixels:number): void {
    if(this.options.canvasMaxPixels === pixels)return;
    this.options.canvasMaxPixels=pixels;
    this.resize(this.width,this.height);
  }


  setToolState(patch: Partial<InkToolState>): void {
    this.toolState = { ...this.toolState, ...patch };
  }

  getToolState(): InkToolState {
    return { ...this.toolState };
  }

  setInputEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return;

    if (!enabled) {
      this.clearCancelGraceTimer();
      this.finishInterruptedInput();
      }

    this.inputEnabled = enabled;
  }

  undo(): void {
    this.flushPendingStrokes();
    const change=this.history.undo();if(!change)return;
    this.strokes=applyStrokeChange(this.strokes,change,false);
    this.renderCommittedNow();this.options.onChange();
  }
  redo(): void {
    this.flushPendingStrokes();
    const change=this.history.redo();if(!change)return;
    this.strokes=applyStrokeChange(this.strokes,change);
    this.renderCommittedNow();this.options.onChange();
  }
  clear(): void { this.replaceStrokes([]); }

  private bindEvents(): void {
    this.liveCanvas.addEventListener("lostpointercapture", this.onLostPointerCapture, { passive: false });
    this.touchEventTarget.addEventListener("touchstart", this.onTouchStart as EventListener, { passive: false, capture: true });
    this.touchEventTarget.addEventListener("touchmove", this.onTouchMove as EventListener, { passive: false, capture: true });
    this.touchEventTarget.addEventListener("touchend", this.onTouchEnd as EventListener, { passive: false, capture: true });
    this.touchEventTarget.addEventListener("touchcancel", this.onTouchCancel as EventListener, { passive: false, capture: true });
    this.eventDocument.addEventListener("pointerdown", this.onPointerDown, { passive: false, capture: true });
    this.eventDocument.addEventListener("pointermove", this.onPointerMove, { passive: false, capture: true });
    this.eventDocument.addEventListener("pointerup", this.onPointerUp, { passive: false, capture: true });
    this.eventDocument.addEventListener("pointercancel", this.onPointerCancel, { passive: false, capture: true });
    this.eventDocument.addEventListener("selectstart", this.onDocumentBlockedGesture, { capture: true });
    this.eventDocument.addEventListener("dragstart", this.onDocumentBlockedGesture, { capture: true });
    this.eventDocument.addEventListener("contextmenu", this.onDocumentBlockedGesture, { capture: true });
    this.eventDocument.addEventListener("selectionchange", this.onDocumentSelectionChange);
    this.eventDocument.addEventListener("pointerdown", this.onDocumentPointerProbe, { capture: true });
    this.eventDocument.addEventListener("pointermove", this.onDocumentPointerProbe, { capture: true });
  }

  private setupInkCanvas(canvas: HTMLCanvasElement, displayScale: number): CanvasRenderingContext2D {
    return setupCanvas(canvas, this.width, this.height, {
      maxDpr: this.options.canvasMaxDpr,
      maxPixels: this.options.canvasMaxPixels,
      displayScale
    });
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.isEventFromToolbar(event)) return;
    if (!this.inputEnabled) return;
    if (!this.isEventInsideAnnotation(event)) return;

    // A Pencil contact can emit both event families. Once Touch owns it,
    // a companion pointerdown must not commit its starting point as a dot.
    if (this.toolState.tool !== "eraser" && this.activeTouchId !== null && event.pointerType !== "mouse") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.shouldIgnoreSuppressedTouchPointer(event)) {
      this.debugIgnoredPointerEvent("ignore-pointerdown", event, "suppressed-touch");
      return;
    }
    if (this.shouldRejectTouchDuringPen(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.debugIgnoredPointerEvent("ignore-pointerdown", event, "pen-palm-reject");
      return;
    }
    if (!this.isClientInsideInputRegion(event.clientX, event.clientY)) {
      this.debugIgnoredPointerEvent("ignore-pointerdown", event, "outside-canvas");
      if (this.shouldPanOutsideCanvas(event)) {
        this.beginPan(event);
      }
      return;
    }

    const wantsWrite = this.shouldWrite(event);
    if (!wantsWrite) {
      this.debugIgnoredPointerEvent("ignore-pointerdown", event, "pan-mode");
    }

    // Erasing must follow Pencil pointer updates even when Touch started first
    // or was cancelled. Keep one gesture, undo snapshot and save pause.
    if (this.toolState.tool === "eraser" && event.pointerType === "pen" && this.activeTouchId !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.clearCancelGraceTimer();
      this.activeTouchId = null;
      this.activePointerId = event.pointerId;
      this.capturePointerIfUseful(event);
      this.notePenActivity();
      this.eraseAtEvent(event);
      return;
    }

    if (wantsWrite && this.tryResumePointerStroke(event)) return;

    if (this.activePointerId !== null || this.activeTouchId !== null || this.panPointerId !== null) {
      if (!wantsWrite) return;
      this.finishInterruptedInput();
    }

    if (!wantsWrite) {
      this.beginPan(event);
      return;
    }

    this.startPointerStroke(event, "pointerdown");
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.isEventFromToolbar(event) && this.activePointerId !== event.pointerId && this.panPointerId !== event.pointerId) return;
    if (!this.inputEnabled) return;
    if (!this.isEventInsideAnnotation(event) && this.activePointerId !== event.pointerId && this.panPointerId !== event.pointerId) return;

    if (this.shouldIgnoreSuppressedTouchPointer(event)) {
      this.debugIgnoredPointerEvent("ignore-pointermove", event, "suppressed-touch");
      return;
    }
    if (this.shouldRejectTouchDuringPen(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.panPointerId === event.pointerId) {
      this.updatePan(event);
      return;
    }

    if (this.activePointerId !== event.pointerId) {
      if (this.shouldRecoverPointerStroke(event)) {
        this.startPointerStroke(event, "recover-move");
      } else if (this.shouldDebugStrayPointer(event)) {
        this.debugIgnoredPointerEvent("stray-pointermove", event, this.isClientInsideInputRegion(event.clientX, event.clientY) ? "no-active" : "outside-canvas");
      }
      return;
    }
    this.clearCancelGraceTimer();

    event.preventDefault();
    event.stopPropagation();

    if (this.toolState.tool === "eraser") {
      this.eraseAtEvent(event);
      return;
    }

    if (!this.activeStroke) return;
    this.clearPredictedStroke();
    const previousPointCount = this.activeStroke.points.length;
    this.appendEventPoints(this.activeStroke, event);
    if (event.pointerType === "pen") {
      this.notePenActivity();
    }
    this.renderLiveIncrement(this.activeStroke, previousPointCount);
    this.pendingPredictionEvent=event;
    this.debugMoveCounter++;
    if (this.debugMoveCounter % 8 === 0) {
      this.debugPointerEvent("pointermove", event, this.activeStroke.points.length);
    }
    this.renderLiveSoon();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.isEventFromToolbar(event) && this.activePointerId !== event.pointerId && this.panPointerId !== event.pointerId) return;
    if (!this.inputEnabled) return;
    if (!this.isEventInsideAnnotation(event) && this.activePointerId !== event.pointerId && this.panPointerId !== event.pointerId) return;

    if (this.shouldIgnoreSuppressedTouchPointer(event)) return;
    if (this.shouldRejectTouchDuringPen(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.panPointerId === event.pointerId) {
      this.endPan(event);
      return;
    }

    if (this.activePointerId !== event.pointerId) return;
    this.clearCancelGraceTimer();

    event.preventDefault();
    event.stopPropagation();

    if (this.toolState.tool === "eraser") {
      this.finishEraser(event);
      return;
    }

    const stroke = this.activeStroke;
    this.clearPredictedStroke();
    if (stroke) {
      const previousPointCount = stroke.points.length;
      this.appendEventPoints(stroke, event);
      this.renderLiveIncrement(stroke, previousPointCount);
    }
    this.debugPointerEvent("pointerup", event, stroke?.points.length);
    if (event.pointerType === "pen") {
      this.notePenActivity();
    }

    this.activeStroke = null;
    this.activePointerId = null;
    this.safeReleasePointer(event.pointerId);

    if (stroke) {
      this.commitStrokeSoon(stroke);
      this.renderLiveSoon();
    }
    this.options.onInputEnd?.();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (!this.inputEnabled) return;
    if (!this.isEventInsideAnnotation(event) && this.activePointerId !== event.pointerId && this.panPointerId !== event.pointerId) return;

    if (this.shouldIgnoreSuppressedTouchPointer(event)) return;

    if (this.panPointerId === event.pointerId) {
      this.endPan(event);
      return;
    }

    if (this.activePointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    this.debugPointerEvent("pointercancel", event, this.activeStroke?.points.length, "grace");
    this.clearPredictedStroke();

    if (this.toolState.tool === "eraser") {
      this.scheduleCancelFinish(() => this.finishEraserAfterCancel(event.pointerId));
      return;
    }

    this.scheduleCancelFinish(() => this.finishPointerStrokeAfterCancel(event.pointerId));
  };

  private onLostPointerCapture = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId && this.panPointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    this.debugPointerEvent("lostcapture", event, this.activeStroke?.points.length);
    this.clearPredictedStroke();
  };

  private onTouchStart = (event: TouchEvent): void => {
    if (this.isEventFromToolbar(event)) return;
    if (!this.inputEnabled) return;
    if (!this.isEventInsideAnnotation(event)) return;
    const canvasTouches = Array.from(event.touches);
    if (canvasTouches.length > 1) {
      if (this.activeTouchId !== null || (this.options.nativeScroll && this.activePointerId !== null)) {
        this.finishInterruptedInput();
      }
      return;
    }

    const touch = event.changedTouches.item(0);
    if (!touch) return;
    if (!this.isClientInsideInputRegion(touch.clientX, touch.clientY)) return;

    const canWrite = this.toolState.acceptTouchInput || this.shouldTreatTouchAsPen(touch);
    if (!canWrite) {
      if (this.options.nativeScroll ? this.isInputActive() : performance.now() < this.suppressTouchPanUntil) {
        event.preventDefault();
        event.stopPropagation();
        this.debugTouchEvent("reject-touch-palm", touch, event);
      }
      return;
    }

    this.suppressTouchPointerUntil = performance.now() + TOUCH_POINTER_SUPPRESSION_MS;
    event.preventDefault();
    event.stopPropagation();
    this.clearTextSelection();
    this.debugTouchEvent("touchstart", touch, event);

    // A companion touchstart must not divert a working eraser pointer stream.
    // If Pointer was cancelled, the handoff below still allows Touch fallback.
    if (this.toolState.tool === "eraser" && this.activePointerId !== null && this.cancelGraceTimer === null) return;

    // iPad may deliver pointerdown before the matching stylus touchstart.
    // Transfer ownership without committing ink, ending input, or resetting
    // eraser history; subsequent pointer events cannot restart this stroke.
    if (this.activePointerId !== null) {
      const pointerId = this.activePointerId;
      this.activePointerId = null;
      this.activeTouchId = touch.identifier;
      this.clearCancelGraceTimer();
      this.clearPredictedStroke();
      this.safeReleasePointer(pointerId);
      if (this.activeStroke) {
        const previousPointCount = this.activeStroke.points.length;
        this.appendTouchPoint(this.activeStroke, touch, event);
        this.renderLiveIncrement(this.activeStroke, previousPointCount);
      } else if (this.toolState.tool === "eraser") {
        this.eraseAtTouch(touch, event);
      }
      this.notePenActivity();
      return;
    }

    if (this.tryResumeTouchStroke(touch, event)) return;

    if (this.activePointerId !== null || this.activeTouchId !== null || this.panPointerId !== null) {
      this.finishInterruptedInput();
    }

    this.options.onInputStart?.();
    this.activeTouchId = touch.identifier;

    if (this.toolState.tool === "eraser") {
        this.eraserChanged = false;
      this.eraserBefore=this.strokes;
      this.lastErasePoint=null;
      this.eraseAtTouch(touch, event);
      return;
    }

    const stroke = this.createStroke();
    this.activeStroke = stroke;
    const previousPointCount = stroke.points.length;
    this.appendTouchPoint(stroke, touch, event);
    this.notePenActivity();
    this.renderLiveIncrement(stroke, previousPointCount);
    this.renderLiveSoon();
  };

  private onTouchMove = (event: TouchEvent): void => {
    if (!this.inputEnabled) return;
    if (this.activeTouchId === null) return;

    const touch = this.findChangedTouch(event, this.activeTouchId);
    if (!touch) return;
    this.clearCancelGraceTimer();

    this.suppressTouchPointerUntil = performance.now() + TOUCH_POINTER_SUPPRESSION_MS;
    event.preventDefault();
    event.stopPropagation();

    if (this.toolState.tool === "eraser") {
      this.eraseAtTouch(touch, event);
      return;
    }

    if (!this.activeStroke) return;
    const previousPointCount = this.activeStroke.points.length;
    this.appendTouchPoint(this.activeStroke, touch, event);
    this.notePenActivity();
    this.renderLiveIncrement(this.activeStroke, previousPointCount);
    this.debugMoveCounter++;
    if (this.debugMoveCounter % 8 === 0) {
      this.debugTouchEvent("touchmove", touch, event, this.activeStroke.points.length);
    }
    this.renderLiveSoon();
  };

  private onTouchEnd = (event: TouchEvent): void => {
    if (!this.inputEnabled) return;
    if (this.activeTouchId === null) return;

    const touch = this.findChangedTouch(event, this.activeTouchId);
    if (!touch) return;
    this.clearCancelGraceTimer();

    this.suppressTouchPointerUntil = performance.now() + TOUCH_POINTER_SUPPRESSION_MS;
    event.preventDefault();
    event.stopPropagation();

    if (this.toolState.tool === "eraser") {
      this.eraseAtTouch(touch,event);
      this.finishTouchEraser();
      return;
    }

    const stroke = this.activeStroke;
    if (stroke) {
      const previousPointCount = stroke.points.length;
      this.appendTouchPoint(stroke, touch, event);
      this.notePenActivity();
      this.renderLiveIncrement(stroke, previousPointCount);
    }
    this.debugTouchEvent("touchend", touch, event, stroke?.points.length);

    this.activeStroke = null;
    this.activeTouchId = null;

    if (stroke) {
      this.commitStrokeSoon(stroke);
      this.renderLiveSoon();
    }
    this.options.onInputEnd?.();
  };

  private onTouchCancel = (event: TouchEvent): void => {
    if (!this.inputEnabled) return;
    if (this.activeTouchId === null) return;

    const touch = this.findChangedTouch(event, this.activeTouchId);
    if (!touch) return;

    this.suppressTouchPointerUntil = performance.now() + TOUCH_POINTER_SUPPRESSION_MS;
    event.preventDefault();
    event.stopPropagation();
    this.debugTouchEvent("touchcancel", touch, event, this.activeStroke?.points.length, "grace");

    if (this.toolState.tool === "eraser") {
      this.scheduleCancelFinish(() => this.finishTouchEraserAfterCancel());
      return;
    }

    this.scheduleCancelFinish(() => this.finishTouchStrokeAfterCancel());
  };

  private onDocumentBlockedGesture = (event: Event): void => {
    if (this.options.nativeScroll && !this.isInputActive()) return;
    if (this.isEventFromToolbar(event)) return;
    if (!this.inputEnabled) return;
    if (!this.isEventInsideAnnotation(event)) return;

    event.preventDefault();
    event.stopPropagation();
  };

  private onDocumentSelectionChange = (): void => {
    if (!this.inputEnabled) return;
    if (this.options.nativeScroll && !this.isInputActive()) return;

    const selection = this.eventDocument.getSelection();
    if (!selection || selection.isCollapsed) return;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (this.isNodeInsideAnnotation(anchorNode) || this.isNodeInsideAnnotation(focusNode)) {
      selection.removeAllRanges();
    }
  };

  private onDocumentPointerProbe = (event: PointerEvent): void => {
    if (!this.inputEnabled) return;

    if (event.pointerType !== "pen") return;
    if (!this.isPointerInContact(event)) return;
    if (!this.isNearCanvas(event.clientX, event.clientY, 48)) return;

    if (event.type === "pointerdown") {
      this.debugIgnoredPointerEvent("probe-pointerdown", event, this.isClientInsideInputRegion(event.clientX, event.clientY) ? "inside" : "near-outside");
      return;
    }

    this.debugMoveCounter++;
    if (this.debugMoveCounter % 16 === 0 && this.activePointerId !== event.pointerId) {
      this.debugIgnoredPointerEvent("probe-pointermove", event, this.isClientInsideInputRegion(event.clientX, event.clientY) ? "inside-no-active" : "near-outside");
    }
  };

  private startPointerStroke(event: PointerEvent, name: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.clearPredictedStroke();
    this.clearTextSelection();
    this.debugPointerEvent(name, event);
    this.options.onInputStart?.();
    if (event.pointerType === "pen") {
      this.notePenActivity();
    }
    this.capturePointerIfUseful(event);
    this.activePointerId = event.pointerId;

    if (this.toolState.tool === "eraser") {
        this.eraserChanged = false;
      this.eraserBefore=this.strokes;
      this.lastErasePoint=null;
      this.eraseAtEvent(event);
      return;
    }

    const stroke = this.createStroke();
    this.activeStroke = stroke;
    const previousPointCount = stroke.points.length;
    this.appendEventPoints(stroke, event);
    this.renderLiveIncrement(stroke, previousPointCount);
    this.renderLiveSoon();
  }

  private shouldRecoverPointerStroke(event: PointerEvent): boolean {
    if (this.options.recoverPointerOnMove === false) return false;
    if (this.activePointerId !== null || this.activeTouchId !== null || this.panPointerId !== null) return false;
    if (!this.shouldWrite(event)) return false;
    if (!this.isPointerInContact(event)) return false;
    return this.isClientInsideInputRegion(event.clientX, event.clientY);
  }

  private isPointerInContact(event: PointerEvent): boolean {
    if (event.pointerType === "pen") return event.pressure > 0 || event.buttons !== 0;
    if (event.pointerType === "mouse") return event.buttons !== 0;
    if (event.pointerType === "touch") return event.pressure > 0 || event.buttons !== 0;
    return false;
  }

  private shouldDebugStrayPointer(event: PointerEvent): boolean {
    if (event.pointerType !== "pen") return false;
    if (!this.isPointerInContact(event)) return false;
    return this.debugMoveCounter % 8 === 0;
  }

  private tryResumePointerStroke(event: PointerEvent): boolean {
    if (this.cancelGraceTimer === null || !this.activeStroke || this.toolState.tool === "eraser") return false;

    event.preventDefault();
    event.stopPropagation();
    this.options.onInputStart?.();
    this.clearCancelGraceTimer();
    this.activeTouchId = null;
    this.activePointerId = event.pointerId;
    this.capturePointerIfUseful(event);
    const previousPointCount = this.activeStroke.points.length;
    this.appendEventPoints(this.activeStroke, event);
    if (event.pointerType === "pen") {
      this.notePenActivity();
    }
    this.renderLiveIncrement(this.activeStroke, previousPointCount);
    this.debugPointerEvent("resume-pointer", event, this.activeStroke.points.length);
    this.renderLiveSoon();
    return true;
  }

  private tryResumeTouchStroke(touch: Touch, event: TouchEvent): boolean {
    if (this.cancelGraceTimer === null || !this.activeStroke || this.toolState.tool === "eraser") return false;

    this.options.onInputStart?.();
    this.clearCancelGraceTimer();
    this.activePointerId = null;
    this.activeTouchId = touch.identifier;
    const previousPointCount = this.activeStroke.points.length;
    this.appendTouchPoint(this.activeStroke, touch, event);
    this.renderLiveIncrement(this.activeStroke, previousPointCount);
    this.debugTouchEvent("resume-touch", touch, event, this.activeStroke.points.length);
    this.renderLiveSoon();
    return true;
  }

  private scheduleCancelFinish(finish: () => void): void {
    this.clearCancelGraceTimer();
    this.cancelGraceTimer = window.setTimeout(() => {
      this.cancelGraceTimer = null;
      this.debugRaw("cancel-timeout", this.activeStroke?.points.length);
      finish();
    }, CANCEL_GRACE_MS);
  }

  private clearCancelGraceTimer(): void {
    if (this.cancelGraceTimer === null) return;

    window.clearTimeout(this.cancelGraceTimer);
    this.cancelGraceTimer = null;
  }

  private shouldWrite(event: PointerEvent): boolean {
    if (event.pointerType === "pen") return true;
    if (event.pointerType === "mouse") return true;
    if (this.shouldTreatTouchPointerAsPen(event)) return true;
    if (event.pointerType === "touch" && this.toolState.acceptTouchInput) return true;
    return false;
  }

  private shouldPanOutsideCanvas(event: PointerEvent): boolean {
    return this.options.panOutsideCanvas !== false
      && event.pointerType === "mouse"
      && event.button === 0
      && event.buttons === 1;
  }

  private shouldIgnoreSuppressedTouchPointer(event: PointerEvent): boolean {
    return event.pointerType === "touch" && performance.now() < this.suppressTouchPointerUntil;
  }

  private shouldRejectTouchDuringPen(event: PointerEvent): boolean {
    if(this.options.nativeScroll)return event.pointerType === "touch" && this.isInputActive();
    return event.pointerType === "touch"
      && performance.now() < this.suppressTouchPanUntil
      && !this.shouldTreatTouchPointerAsPen(event);
  }

  private notePenActivity(): void {
    this.suppressTouchPanUntil = performance.now() + PEN_TOUCH_REJECTION_MS;
  }

  private shouldTreatTouchPointerAsPen(event: PointerEvent): boolean {
    if (event.pointerType !== "touch") return false;
    if (this.toolState.acceptTouchInput) return true;
    if (this.options.nativeScroll) return false;
    if (performance.now() >= this.suppressTouchPanUntil) return false;

    return this.hasFineContact(event.width, event.height, event.pressure);
  }

  private shouldTreatTouchAsPen(touch: Touch): boolean {
    if (this.toolState.acceptTouchInput) return true;

    const candidate = touch as Touch & {
      touchType?: string;
      radiusX?: number;
      radiusY?: number;
      force?: number;
    };

    if (candidate.touchType === "stylus") return true;
    if (this.options.nativeScroll) return false;
    if (performance.now() >= this.suppressTouchPanUntil) return false;
    return this.hasFineContact(candidate.radiusX, candidate.radiusY, candidate.force);
  }

  private hasFineContact(width?: number, height?: number, pressure?: number): boolean {
    const maxSize = Math.max(width ?? 0, height ?? 0);
    const hasSmallContact = maxSize > 0 && maxSize <= 18;
    const hasPressure = pressure === undefined || pressure >= 0.02;

    return hasSmallContact && hasPressure;
  }

  private createStroke(): InkStroke {
    return {
      id: crypto.randomUUID(),
      tool: this.toolState.tool === "highlighter" ? "highlighter" : "pen",
      color: this.toolState.tool === "highlighter" ? this.toolState.highlighterColor : this.toolState.color,
      width: this.toolState.tool === "highlighter" ? this.toolState.highlighterWidth : this.toolState.width,
      points: []
    };
  }

  private beginPan(event: PointerEvent): void {
    if(this.options.nativeScroll)return;
    event.preventDefault();
    event.stopPropagation();
    this.panPointerId = event.pointerId;
    this.lastPanClientX = event.clientX;
    this.lastPanClientY = event.clientY;
    try {
      this.liveCanvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail when pan starts from scroll whitespace.
    }
  }

  private updatePan(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - this.lastPanClientX;
    const dy = event.clientY - this.lastPanClientY;
    this.scrollEl.scrollLeft -= dx;
    this.scrollEl.scrollTop -= dy;
    this.lastPanClientX = event.clientX;
    this.lastPanClientY = event.clientY;
  }

  private endPan(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.panPointerId = null;
    this.safeReleasePointer(event.pointerId);
  }

  private appendEventPoints(stroke: InkStroke, event: PointerEvent): void {
    const coalescedEvents = typeof event.getCoalescedEvents === "function"
      ? event.getCoalescedEvents()
      : [event];
    const events = coalescedEvents.length > 0 ? coalescedEvents : [event];
    const mapping = this.getCanvasPointMapping();

    for (let i = 0; i < events.length; i++) {
      const coalesced = events[i];
      const point = this.eventToPoint(coalesced, this.nextSampleTime(coalesced.timeStamp), mapping);
      this.appendPoint(stroke, point);
    }

    const lastEvent = events[events.length - 1];
    if (lastEvent && (lastEvent.clientX !== event.clientX || lastEvent.clientY !== event.clientY)) {
      this.appendPoint(stroke, this.eventToPoint(event, this.nextSampleTime(event.timeStamp), mapping));
    }
  }

  private renderPredictedStroke(stroke: InkStroke, event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    if (stroke.points.length === 0) return;

    const eventWithPrediction = event as PointerEvent & {
      getPredictedEvents?: () => PointerEvent[];
    };
    const predictedEvents = typeof eventWithPrediction.getPredictedEvents === "function"
      ? eventWithPrediction.getPredictedEvents()
      : [];
    if (!predictedEvents || predictedEvents.length === 0) return;

    const mapping = this.getCanvasPointMapping();
    const lastRealPoint = stroke.points[stroke.points.length - 1];
    const predictedPoints: InkPoint[] = [];
    let lastPoint = lastRealPoint;

    for (const predicted of predictedEvents) {
      if (predicted.pointerType !== "pen") continue;
      if (!this.isClientInsideCanvas(predicted.clientX, predicted.clientY)) continue;
      if (Number.isFinite(predicted.timeStamp)
        && Number.isFinite(event.timeStamp)
        && predicted.timeStamp - event.timeStamp > MAX_PREDICTED_EVENT_TIME_AHEAD_MS) {
        continue;
      }

      const point = this.eventToPoint(predicted, Math.max(lastPoint.t + 0.001, performance.now()), mapping);
      if (distanceSquared(lastPoint, point) < MIN_POINT_DISTANCE_SQ) continue;

      predictedPoints.push(point);
      lastPoint = point;
      if (predictedPoints.length >= MAX_PREDICTED_POINTS) break;
    }

    if (predictedPoints.length === 0) return;

    const predictedStroke: InkStroke = {
      ...stroke,
      points: [lastRealPoint, ...predictedPoints]
    };
    drawStrokeSegment(this.liveCtx, predictedStroke, 1);
    drawStrokeTail(this.liveCtx,predictedStroke);
    this.predictedStrokeRendered = true;
  }

  private clearPredictedStroke(): void {
    if (!this.predictedStrokeRendered) return;

    this.clearLiveCanvas();
  }

  private appendTouchPoint(stroke: InkStroke, touch: Touch, event: TouchEvent): void {
    const candidate = touch as Touch & { force?: number };
    const mapping = this.getCanvasPointMapping();
    this.appendPoint(stroke, this.clientToPoint(
      touch.clientX,
      touch.clientY,
      this.nextSampleTime(event.timeStamp),
      Number.isFinite(candidate.force) && candidate.force !== undefined && candidate.force > 0 ? candidate.force : 0.5,
      mapping
    ));
  }

  private appendPoint(stroke: InkStroke, point: InkPoint): void {
    const last = stroke.points[stroke.points.length - 1];
    if (last) {
      const gap = point.t - last.t;
      if (distanceSquared(last, point) < MIN_POINT_DISTANCE_SQ && gap < MAX_POINT_GAP_MS) {
        return;
      }
    }
    stroke.points.push(point);
  }

  private eventToPoint(event: PointerEvent, timeStamp = this.nextSampleTime(), mapping = this.getCanvasPointMapping()): InkPoint {
    return this.clientToPoint(
      event.clientX,
      event.clientY,
      timeStamp,
      Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : this.activeStroke?.points[this.activeStroke.points.length-1]?.pressure ?? 0.5,
      mapping,
      event.tiltX,
      event.tiltY
    );
  }

  private clientToPoint(clientX: number, clientY: number, timeStamp: number, pressure: number, mapping = this.getCanvasPointMapping(), tiltX?: number, tiltY?: number): InkPoint {
    return {
      x: (clientX - mapping.left) * mapping.scaleX,
      y: (clientY - mapping.top) * mapping.scaleY,
      t: timeStamp,
      pressure,
      tiltX,
      tiltY
    };
  }

  private getCanvasPointMapping(): CanvasPointMapping {
    const rect = this.liveCanvas.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      scaleX: this.width / Math.max(1, rect.width),
      scaleY: this.height / Math.max(1, rect.height)
    };
  }

  private isClientInsideCanvas(clientX: number, clientY: number): boolean {
    const rect = this.liveCanvas.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  private isClientInsideInputRegion(clientX: number, clientY: number): boolean {
    if (!this.isClientInsideCanvas(clientX, clientY)) return false;
    if (this.toolState.tool === "eraser") return true;

    const bounds = this.options.inputBounds;
    if (!bounds) return true;

    const rect = this.liveCanvas.getBoundingClientRect();
    const scaleY = this.height / Math.max(1, rect.height);
    const localY = (clientY - rect.top) * scaleY;
    const top = Math.max(0, Math.min(this.height, bounds.top));
    const bottom = Math.max(top, Math.min(this.height, bounds.bottom));
    return localY >= top && localY < bottom;
  }

  private isNearCanvas(clientX: number, clientY: number, margin: number): boolean {
    const rect = this.liveCanvas.getBoundingClientRect();
    return clientX >= rect.left - margin
      && clientX <= rect.right + margin
      && clientY >= rect.top - margin
      && clientY <= rect.bottom + margin;
  }

  private isEventInsideAnnotation(event: Event): boolean {
    const target = event.target;
    return target instanceof Node && this.isNodeInsideAnnotation(target);
  }

  private isEventFromToolbar(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;

    if (target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav")) return true;

    if (target.closest(".mobile-ink-object-control, .mobile-ink-object-resize-handle, .mobile-ink-object-delete")) {
      return true;
    }

    return false;
  }

  private isNodeInsideAnnotation(node: Node | null): boolean {
    if (!node) return false;
    if(this.options.inputRoot)return this.options.inputRoot.contains(node);

    const root = this.scrollEl.closest(".mobile-ink-root");
    return !!root
      ? root.contains(node)
      : this.scrollEl.contains(node) || this.liveCanvas.contains(node) || this.committedCanvas.contains(node);
  }

  private clearTextSelection(): void {
    this.eventDocument.getSelection()?.removeAllRanges();
  }

  private nextSampleTime(time = performance.now()): number {
    const now = Number.isFinite(time) && time >= 0 ? time : performance.now();
    this.sampleTime = Math.max(now, this.sampleTime + 0.001);
    return this.sampleTime;
  }

  private debugPointerEvent(name: string, event: PointerEvent, points?: number, detail?: string): void {
    this.options.onDebug?.({
      time: performance.now(),
      name,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      points,
      x: event.clientX,
      y: event.clientY,
      detail
    });
  }

  private debugIgnoredPointerEvent(name: string, event: PointerEvent, reason: string): void {
    if (event.pointerType !== "pen" && event.pointerType !== "touch") return;

    this.options.onDebug?.({
      time: performance.now(),
      name,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      detail: `${reason} ${this.describeEventTarget(event)}`
    });
  }

  private debugTouchEvent(name: string, touch: Touch, event: TouchEvent, points?: number, detail?: string): void {
    this.options.onDebug?.({
      time: performance.now(),
      name,
      touchId: touch.identifier,
      points,
      x: touch.clientX,
      y: touch.clientY,
      detail: detail ?? `touches=${event.touches.length}`
    });
  }

  private debugStroke(name: string, stroke: InkStroke): void {
    const last = stroke.points[stroke.points.length - 1];
    this.options.onDebug?.({
      time: performance.now(),
      name,
      points: stroke.points.length,
      x: last?.x,
      y: last?.y,
      detail: stroke.tool
    });
  }

  private debugRaw(name: string, points?: number, detail?: string): void {
    this.options.onDebug?.({
      time: performance.now(),
      name,
      points,
      detail
    });
  }

  private notifyEraserChange(): void {
    if(this.eraserBefore && !this.options.externalHistory)this.history.record(strokeChange(this.eraserBefore,this.strokes));
    this.eraserBefore=null;
    this.options.onChange();
  }

  private describeEventTarget(event: Event): string {
    const target = event.target;
    if (!(target instanceof Element)) return "target=?";

    const className = typeof target.className === "string" ? target.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const id = target.id ? `#${target.id}` : "";
    return `target=${target.tagName.toLowerCase()}${id}${className ? `.${className}` : ""}`;
  }

  private commitStroke(stroke: InkStroke): void {
    if(!stroke.points.length)return;
    this.flushStrokeRender(stroke,true);
    if(!this.options.externalHistory)this.history.record({removed:[],added:[{index:this.strokes.length,stroke}]});
    this.strokes=[...this.strokes,stroke];
    this.options.onStrokeCommit?.(stroke);
    this.options.onChange();
  }

  private renderLiveSoon(): void {
    if(this.liveRenderRaf!==null || !this.queuedStroke)return;
    this.liveRenderRaf=requestAnimationFrame(()=>{
      this.liveRenderRaf=null;
      const stroke=this.queuedStroke;
      if(stroke)this.flushStrokeRender(stroke,false);
    });
  }
  private renderLiveIncrement(stroke:InkStroke,_previousPointCount:number):void {
    this.queuedStroke=stroke;this.renderLiveSoon();
  }
  private flushStrokeRender(stroke:InkStroke,finished:boolean):void {
    const count=this.renderedPointCounts.get(stroke) ?? 0;
    if(stroke.tool==='highlighter') {
      this.liveCanvas.style.opacity='0.35';this.liveCanvas.style.mixBlendMode='multiply';
      drawStrokeSegment(this.liveCtx,stroke,count,true);
      if(finished) {drawStroke(this.committedCtx,stroke);this.clearLiveCanvas();}
    } else {
      this.liveCanvas.style.opacity='1';this.liveCanvas.style.mixBlendMode='normal';
      this.clearLiveCanvas();
      drawStrokeSegment(this.committedCtx,stroke,count);
      if(finished)drawStrokeTail(this.committedCtx,stroke);
      else {
        drawStrokeTail(this.liveCtx,stroke);
        const tail=stroke.points.slice(-2),pad=stroke.width*2+4;
        const xs=tail.map(p=>p.x),ys=tail.map(p=>p.y);
        this.liveTailBounds={x:Math.min(...xs)-pad,y:Math.min(...ys)-pad,width:Math.max(...xs)-Math.min(...xs)+2*pad,height:Math.max(...ys)-Math.min(...ys)+2*pad};
        // Prediction is transient and is never saved or included in undo history.
        if(this.pendingPredictionEvent)this.renderPredictedStroke(stroke,this.pendingPredictionEvent);
      }
    }
    this.renderedPointCounts.set(stroke,stroke.points.length);
    this.pendingPredictionEvent=null;
    this.queuedStroke=finished ? null : stroke;
  }
  private renderLiveNow():void {
    if(this.activeStroke)this.flushStrokeRender(this.activeStroke,false);
    else {this.clearLiveCanvas();this.queuedStroke=null;}
  }

  private renderCommittedSoon(): void {
    if (this.committedRenderRaf !== null) return;
    this.committedRenderRaf = requestAnimationFrame(() => {
      this.committedRenderRaf = null;
      this.renderCommittedNow();
    });
  }

  private renderCommittedNow(): void {
    this.clearPredictedStroke();
    this.clearCommittedCanvas();
    drawStrokes(this.committedCtx, this.strokes);
    if(this.activeStroke) {
      this.renderedPointCounts.delete(this.activeStroke);
      this.clearLiveCanvas();
      this.flushStrokeRender(this.activeStroke,false);
    }
  }

  private clearLiveCanvas(): void {
    const bounds=this.liveTailBounds;
    if(bounds && !this.predictedStrokeRendered)this.liveCtx.clearRect(bounds.x,bounds.y,bounds.width,bounds.height);
    else this.liveCtx.clearRect(0,0,this.width,this.height);
    this.liveTailBounds=null;
    this.predictedStrokeRendered=false;
  }

  private clearCommittedCanvas(): void {
    this.committedCtx.clearRect(0, 0, this.width, this.height);
  }

  private eraseAtEvent(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const coalescedEvents = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    const mapping = this.getCanvasPointMapping();
    let changed = false;
    for (const coalesced of coalescedEvents.length ? coalescedEvents : [event]) {
      const point = this.eventToPoint(coalesced, this.nextSampleTime(coalesced.timeStamp), mapping);
      changed = this.eraseAtPoint(point) || changed;
    }

    if (changed) {
      this.eraserChanged = true;
      this.renderCommittedSoon();
    }
  }

  private eraseAtTouch(touch: Touch, event: TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const point = this.clientToPoint(
      touch.clientX,
      touch.clientY,
      Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now(),
      0.5,
      this.getCanvasPointMapping()
    );

    if (this.eraseAtPoint(point)) {
      this.eraserChanged = true;
      this.renderCommittedSoon();
    }
  }

  private eraseAtPoint(point: InkPoint): boolean {
    const previous=this.strokes;
    this.strokes=eraseStrokes(previous,this.lastErasePoint??point,point,this.toolState.eraserRadius,this.toolState.eraserMode??"stroke");
    this.lastErasePoint=point;
    return previous.length!==this.strokes.length||previous.some((s,i)=>s!==this.strokes[i]);
  }

  private finishEraser(event: PointerEvent): void {
    this.eraseAtEvent(event);
    event.preventDefault();
    event.stopPropagation();

    this.activePointerId = null;
    this.safeReleasePointer(event.pointerId);

    if (this.eraserChanged) {
      this.notifyEraserChange();
    }

    this.eraserChanged = false;
    this.eraserBefore = null;
    this.options.onInputEnd?.();
  }

  private finishEraserAfterCancel(pointerId: number): void {
    this.activePointerId = null;
    this.safeReleasePointer(pointerId);

    if (this.eraserChanged) {
      this.notifyEraserChange();
    }

    this.eraserChanged = false;
    this.eraserBefore = null;
    this.options.onInputEnd?.();
  }

  private finishTouchEraser(): void {
    this.activeTouchId = null;

    if (this.eraserChanged) {
      this.notifyEraserChange();
    }

    this.eraserChanged = false;
    this.eraserBefore = null;
    this.options.onInputEnd?.();
  }

  private finishPointerStrokeAfterCancel(pointerId: number): void {
    const stroke = this.activeStroke;

    this.activeStroke = null;
    this.activePointerId = null;
    this.safeReleasePointer(pointerId);

    if (stroke && stroke.points.length > 0) {
      this.commitStrokeSoon(stroke);
      this.renderLiveSoon();
    }
    this.options.onInputEnd?.();
  }

  private finishTouchStrokeAfterCancel(): void {
    const stroke = this.activeStroke;

    this.activeStroke = null;
    this.activeTouchId = null;

    if (stroke && stroke.points.length > 0) {
      this.commitStrokeSoon(stroke);
      this.renderLiveSoon();
    }
    this.options.onInputEnd?.();
  }

  private finishTouchEraserAfterCancel(): void {
    this.activeTouchId = null;

    if (this.eraserChanged) {
      this.notifyEraserChange();
    }

    this.eraserChanged = false;
    this.eraserBefore = null;
    this.options.onInputEnd?.();
  }

  private finishInterruptedInput(): void {
    this.clearCancelGraceTimer();
    this.clearPredictedStroke();
    const activePointerId = this.activePointerId;
    const activeTouchId = this.activeTouchId;
    const panPointerId = this.panPointerId;
    const stroke = this.activeStroke;
    const eraserChanged = this.eraserChanged;

    this.activeStroke = null;
    this.activePointerId = null;
    this.activeTouchId = null;
    this.panPointerId = null;
    this.eraserChanged = false;

    if (activePointerId !== null) {
      this.safeReleasePointer(activePointerId);
    }

    if (panPointerId !== null) {
      this.safeReleasePointer(panPointerId);
    }

    if (stroke && stroke.points.length > 0) {
      this.commitStrokeSoon(stroke);
      this.renderLiveSoon();
    } else if (eraserChanged) {
      this.notifyEraserChange();
    }
    if (activePointerId !== null || activeTouchId !== null || stroke || eraserChanged) {
      this.options.onInputEnd?.();
    }
  }

  private safeReleasePointer(pointerId: number): void {
    try {
      if (this.liveCanvas.hasPointerCapture(pointerId)) {
        this.liveCanvas.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore browser-specific pointer capture release errors.
    }
  }

  private capturePointerIfUseful(event: PointerEvent): void {
    if (event.pointerType !== "mouse") return;

    try {
      this.liveCanvas.setPointerCapture(event.pointerId);
    } catch {
      // Ignore browser-specific pointer capture errors.
    }
  }

  private commitStrokeSoon(stroke:InkStroke):void { this.commitStroke(stroke); }
  private findChangedTouch(event: TouchEvent, identifier: number): Touch | null {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches.item(i);
      if (touch?.identifier === identifier) return touch;
    }

    return null;
  }
}

function cloneStrokes(strokes: InkStroke[]): InkStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    erasures:stroke.erasures?.map(e=>({...e,points:e.points.map(p=>({...p}))})),
    points: stroke.points.map((point) => ({ ...point }))
  }));
}
