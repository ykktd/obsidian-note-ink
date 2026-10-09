import type { InkStroke, InkTool } from "../ink/types";

export type AnnotationViewState = {
  file?: string;
  sourcePath?: string;
  standalone?: boolean;
  zoom?: number;
};

export type VisibleInkTool = Extract<InkTool, "pen" | "highlighter" | "eraser">;

export type ToolbarButtonMap = Partial<Record<
  "touch" | "undo" | "redo" | "save" | "exit" | "palette" | "width" | "pen" | "highlighter" | "eraser" | "select" | "strokeSelect" | "capture" | "collapse" | "expand" | "clearAll" | "zoomIn" | "zoomOut" | "zoomReset" | "more" | "exportPdf" | "template" | "insertImage" | "insertShape" | "insertSticker",
  HTMLElement
>>;

export type PagePoint = {
  x: number;
  y: number;
};

export type PageRect = PagePoint & {
  width: number;
  height: number;
};

export type ElectronPrintWindow = {
  loadURL: (url: string) => Promise<void>;
  close: () => void;
  webContents: {
    executeJavaScript: <T = unknown>(code: string) => Promise<T>;
    printToPDF: (options: Record<string, unknown>) => Promise<Uint8Array>;
  };
};

export type ElectronBrowserWindowConstructor = new (options: Record<string, unknown>) => ElectronPrintWindow;

export type NodeRuntimeApi = {
  fs: {
    mkdtempSync: (prefix: string) => string;
    writeFileSync: (path: string, data: string, encoding: "utf8") => void;
    rmSync?: (path: string, options: { recursive: boolean; force: boolean }) => void;
    unlinkSync?: (path: string) => void;
    rmdirSync?: (path: string) => void;
  };
  os: {
    tmpdir: () => string;
  };
  path: {
    join: (...parts: string[]) => string;
  };
  url: {
    pathToFileURL: (path: string) => { href: string };
  };
};

export type PdfExportReadiness = {
  pageWidth: number;
  pageHeight: number;
  strokeElementCount: number;
  visibleRasterImageCount: number;
  selectableTextSpanCount: number;
  textLength: number;
};

export type PdfExportLayout = {
  sourceWidth: number;
  sourceHeight: number;
  cropLeft: number;
  cropWidth: number;
  renderedWidth: number;
  renderedHeight: number;
  pageContentHeight: number;
  pageCount: number;
  scale: number;
  pageRule: string;
  bodyRule: string;
  pageClass: string;
};

export type BrowserPdfRasterPage = {
  jpegBytes: Uint8Array;
  imageWidthPx: number;
  imageHeightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  imageXPt: number;
  imageYPt: number;
  imageWidthPt: number;
  imageHeightPt: number;
  textObjects?: BrowserPdfTextObject[];
};

export type BrowserPdfTextObject = {
  text: string;
  xPt: number;
  baselineYPt: number;
  widthPt: number;
  heightPt: number;
  fontSizePt: number;
};

export type SelectablePdfTextSpan = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  lineHeight: number;
  letterSpacing: string;
  whiteSpace: string;
};

export type SelectablePdfPageImage = {
  dataUrl: string;
  cssWidth: number;
  cssHeight: number;
  sliceTop: number;
  sliceHeight: number;
};

export type PdfFormulaRenderMode = "svg" | "text" | "none";

export type PdfJsViewport = {
  width: number;
  height: number;
  transform?: PdfMatrix;
};

export type PdfJsPage = {
  getViewport: (options: { scale: number }) => PdfJsViewport;
  getTextContent: () => Promise<PdfTextContent>;
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport; transform?: [number, number, number, number, number, number] }) => PdfRenderTask;
};

export type PdfRenderTask = {
  promise: Promise<void>;
  cancel?: () => void;
};

export type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
  getData: () => Promise<Uint8Array>;
  cleanup?: (keepLoadedFonts?: boolean) => Promise<void> | void;
  destroy?: () => Promise<void> | void;
};

export type PdfJsDocumentSource = {
  data: Uint8Array;
  cMapUrl?: string;
  cMapPacked?: boolean;
  standardFontDataUrl?: string;
  useWorkerFetch?: boolean;
  isEvalSupported?: boolean;
  CMapReaderFactory?: unknown;
  StandardFontDataFactory?: unknown;
};

export type PdfJsLib = {
  getDocument: (source: PdfJsDocumentSource) => { promise: Promise<PdfJsDocument> };
};

export type PdfRenderQuality = "none" | "preview" | "sharp";

export type PdfMatrix = [number, number, number, number, number, number];

export type PdfTextContent = {
  items: PdfTextItem[];
  styles?: Record<string, PdfTextStyle | undefined>;
};

export type PdfTextStyle = {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
};

export type PdfTextItem = {
  str: string;
  transform: PdfMatrix;
  width?: number;
  height?: number;
  fontName?: string;
  dir?: string;
  hasEOL?: boolean;
};

export type PdfBackgroundPageEntry = {
  pageNumber: number;
  page?: PdfJsPage;
  viewport: PdfJsViewport;
  offsetY: number;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  textItems: PdfTextLayerItem[];
  annotationLayer: HTMLElement;
  pageEl: HTMLElement;
  renderedQuality: PdfRenderQuality;
  rendering: boolean;
  textRendered: boolean;
  textRendering: boolean;
  renderTask?: PdfRenderTask;
};

export type PdfTextSelectionRect = PageRect & {
  pageNumber: number;
};

export type PdfTextLayerItem = PdfTextSelectionRect & {
  text: string;
  hasEOL?: boolean;
};

export type PdfTextSelectionState = {
  text: string;
  rects: PdfTextSelectionRect[];
  menuPoint: PagePoint;
  visualOnly?: boolean;
};

export type PdfTextDragSelectionState = {
  pointerId: number;
  pageNumber: number;
  start: PagePoint;
  current: PagePoint;
};

export type SelectionDragState = {
  type: "box" | "move" | "capture";
  pointerId: number;
  start: PagePoint;
  originalStrokes?: InkStroke[];
};

export type PinchZoomState = {
  startDistance: number;
  startZoom: number;
};
