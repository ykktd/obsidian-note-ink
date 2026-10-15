export type InkTool = "pen" | "highlighter" | "eraser";

export type InkPoint = {
  x: number;
  y: number;
  t: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
};

export type InkErasePath = { radius: number; points: {x:number;y:number}[] };

export type InkStroke = {
  id: string;
  tool: Exclude<InkTool, "eraser">;
  color: string;
  width: number;
  points: InkPoint[];
  /** Per-stroke cutouts: later writing is never erased by older gestures. */
  erasures?: InkErasePath[];
};

/** PDF user space, independent of scroll position, zoom and display rotation. */
export type PdfInkStroke = InkStroke & { pageNumber: number };
export type PdfAnnotationFile = {
  version: 2;
  kind: "pdf";
  coordinateSpace: "pdf-user-space";
  sourcePath: string;
  sourceMtime: number;
  pageCount: number;
  strokes: PdfInkStroke[];
  /** Rectangles are in PDF user space; pageWidth/pageHeight are not used. */
  pdfTextAnnotations: PdfTextAnnotation[];
  updatedAt: number;
};

export type PdfTextAnnotationKind = "highlight" | "underline" | "strikethrough" | "note";

export type PdfTextAnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfTextAnnotation = {
  /** v2 only: orientation when the text mark was created (for underline/strike). */
  rotation?: number;
  id: string;
  kind: PdfTextAnnotationKind;
  pageNumber: number;
  pageWidth?: number;
  pageHeight?: number;
  color: string;
  text: string;
  rects: PdfTextAnnotationRect[];
  note?: string;
  createdAt: number;
};

export type MarkdownLayoutAnchor = {
  key: string;
  y: number;
  height: number;
};

export type MarkdownLayoutSnapshot = {
  version: 1;
  sourceHash?: string;
  pageWidth: number;
  pageHeight: number;
  anchors: MarkdownLayoutAnchor[];
};

export type StandaloneTemplate = "blank" | "lined" | "grid" | "dotted" | "cornell";

export type StandalonePage = {
  /** 页码，1-indexed */
  pageNumber: number;
  strokes: InkStroke[];
};

export type StandaloneElementKind = "image" | "shape" | "sticker";
export type StandaloneShapeKind = "rect" | "ellipse" | "line" | "note";
export type StandaloneStickerKind =
  | "tape-blue" | "tape-green" | "tape-yellow" | "tape-pink" | "tape-grid" | "tape-floral"
  | "flower" | "paperclip" | "sticky-note" | "label-memo" | "label-todo" | "label-heart"
  | "emoji-smile" | "emoji-laugh" | "emoji-wink" | "emoji-heart-eyes" | "emoji-surprised" | "emoji-thinking" | "emoji-sad" | "emoji-party" | "emoji-sparkles" | "emoji-sun" | "emoji-cloud" | "emoji-rain" | "emoji-rainbow" | "emoji-star"
  | "icon-heart" | "icon-star";

export type StandaloneImageElement = {
  id: string;
  type: "image";
  pageNumber: number;
  sourcePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
  locked?: boolean;
  opacity?: number;
};

export type StandaloneShapeElement = {
  id: string;
  type: "shape";
  pageNumber: number;
  shape: StandaloneShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
  locked?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  borderRadius?: number;
};

export type StandaloneStickerElement = {
  id: string;
  type: "sticker";
  pageNumber: number;
  sticker: StandaloneStickerKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
  locked?: boolean;
  opacity?: number;
  text?: string;
};

export type StandaloneElement = StandaloneImageElement | StandaloneShapeElement | StandaloneStickerElement;

export type AnnotationFile = {
  version: 1;
  sourcePath: string;
  sourceMtime: number;
  pageWidth: number;
  pageHeight: number;
  /** Legacy single-page strokes (kept for non-standalone annotations and backward-compat) */
  strokes: InkStroke[];
  markdownLayout?: MarkdownLayoutSnapshot;
  pdfTextAnnotations?: PdfTextAnnotation[];
  template?: StandaloneTemplate;
  /** Multi-page standalone note pages. If present, supersedes top-level strokes for standalone. */
  pages?: StandalonePage[];
  /** Structured standalone note objects, rendered separately from the ink canvas. */
  elements?: StandaloneElement[];
  updatedAt: number;
};

export type InkToolState = {
  tool: InkTool;
  color: string;
  width: number;
  highlighterColor: string;
  highlighterWidth: number;
  eraserRadius: number;
  eraserMode?: "partial" | "stroke";
  /**
   * false by default: Pencil/stylus writes, finger pans the page.
   * true: finger can also write, useful on Android phones without stylus pointerType support.
   */
  acceptTouchInput: boolean;
};

export type InkEngineOptions = {
  /** Let the native viewer handle finger scroll/pinch instead of manual panning. */
  nativeScroll?: boolean;
  /** Limit captured input to this page, including text-layer event targets. */
  inputRoot?: HTMLElement;
  /** PageInkController owns history for tiled views. */
  externalHistory?: boolean;
  onChange: () => void;
  onStrokeCommit?: (stroke: InkStroke) => void;
  onInputStart?: () => void;
  onInputEnd?: () => void;
  onDebug?: (event: InkDebugEvent) => void;
  initialToolState?: Partial<InkToolState>;
  canvasMaxDpr?: number;
  canvasMaxPixels?: number;
  canvasPixelRatio?: number;
  canvasRegion?: {x:number;y:number;width:number;height:number};
  inputBounds?: {
    top: number;
    bottom: number;
  };
  recoverPointerOnMove?: boolean;
  panOutsideCanvas?: boolean;
};

export type InkDebugEvent = {
  time: number;
  name: string;
  pointerType?: string;
  pointerId?: number;
  touchId?: number;
  points?: number;
  x?: number;
  y?: number;
  detail?: string;
};
