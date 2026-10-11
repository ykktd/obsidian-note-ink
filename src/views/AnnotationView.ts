import { App, FileView, loadPdfJs, MarkdownRenderer, Menu, normalizePath, Notice, setIcon, Setting, TFile, WorkspaceLeaf, ViewStateResult } from "obsidian";
import type MobileInkAnnotationPlugin from "../main";
import { STANDALONE_INK_EXTENSION, VIEW_TYPE_MOBILE_INK } from "../constants";
import { InkEngine } from "../ink/InkEngine";
import type { InkController } from "../ink/InkController";
import { PageInkController, type PageInkDescriptor } from "../ink/PageInkController";
import { SaveQueue } from "../ink/SaveQueue";
import type { AnnotationFile, InkStroke, MarkdownLayoutSnapshot, PdfTextAnnotation, PdfTextAnnotationKind, StandaloneElement, StandalonePage, StandaloneShapeKind, StandaloneStickerKind, StandaloneTemplate } from "../ink/types";
import { PdfPageNavigatorManager, type PdfPageNavigatorPage } from "../pdf/PdfPageNavigatorManager";
import { isMobileInkEnvironment } from "../utils/platform";
import { nextFrame, waitForImages } from "../utils/dom";
import { BundledCMapReaderFactory, BundledStandardFontDataFactory } from "../pdf/pdfAssetReaders";
import { assertDimensions, MAX_PDF_PAGE_HEIGHT, MAX_PDF_PAGES } from "../utils/resourceLimits";
import { exportAnnotatedPdf, type ExportPage } from "../pdf/exportAnnotatedPdf";
import { saveExportCopy } from "../pdf/saveExportCopy";
import { stableHash } from "../utils/hash";
import {
  CSS_PX_PER_MM,
  INK_DESKTOP_MAX_DISPLAY_SCALE,
  MARKDOWN_TILED_INK_DESKTOP_MAX_SINGLE_PIXELS,
  MARKDOWN_TILED_INK_DESKTOP_TILE_HEIGHT,
  MARKDOWN_TILED_INK_MOBILE_MAX_SINGLE_PIXELS,
  MARKDOWN_TILED_INK_MOBILE_TILE_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  PDF_A4_HEIGHT_MM,
  PDF_A4_MARGIN_MM,
  PDF_A4_WIDTH_MM,
  PDF_BACKGROUND_CACHE_CLEANUP_IDLE_MS,
  PDF_BACKGROUND_DESKTOP_MAX_DPR,
  PDF_BACKGROUND_DESKTOP_MAX_WIDTH,
  PDF_BACKGROUND_DESKTOP_PREVIEW_DPR,
  PDF_BACKGROUND_DESKTOP_RENDERED_PAGE_BUDGET,
  PDF_BACKGROUND_DESKTOP_SHARP_DPR,
  PDF_BACKGROUND_MOBILE_DEFAULT_BUDGET,
  PDF_BACKGROUND_MOBILE_LONG_DOC_PAGES,
  PDF_BACKGROUND_MOBILE_LONG_DOC_SHARP_DPR,
  PDF_BACKGROUND_MOBILE_LONG_DOC_BUDGET,
  PDF_BACKGROUND_MOBILE_MAX_WIDTH,
  PDF_BACKGROUND_MOBILE_PREVIEW_DPR,
  PDF_BACKGROUND_MOBILE_SHARP_DPR,
  PDF_BACKGROUND_PAGE_GAP,
  PDF_BACKGROUND_SHARP_IDLE_MS,
  PDF_BROWSER_RASTER_SCALE,
  PDF_EXPORT_EXTRA_BOTTOM_PADDING,
  PDF_PAGE_BREAK_GUARD_PX,
  PDF_PT_PER_CSS_PX,
  PDF_PT_PER_MM,
  PDF_RASTER_JPEG_QUALITY,
  PDF_RASTER_MAX_CANVAS_PIXELS,
  PDF_TEXT_ANNOTATION_COLORS,
  PDF_TEXT_HIGHLIGHT_COLOR,
  PDF_TEXT_NOTE_COLOR,
  PDF_TEXT_STRIKETHROUGH_COLOR,
  PDF_TEXT_UNDERLINE_COLOR,
  ZOOM_STEP
} from "./annotationConstants";
import type {
  AnnotationViewState,
  BrowserPdfRasterPage,
  BrowserPdfTextObject,
  ElectronBrowserWindowConstructor,
  NodeRuntimeApi,
  PagePoint,
  PageRect,
  PdfBackgroundPageEntry,
  PdfExportLayout,
  PdfExportReadiness,
  PdfFormulaRenderMode,
  PdfJsDocument,
  PdfJsDocumentSource,
  PdfJsLib,
  PdfMatrix,
  PdfRenderQuality,
  PdfTextDragSelectionState,
  PdfTextLayerItem,
  PdfTextSelectionRect,
  PdfTextSelectionState,
  PinchZoomState,
  SelectablePdfPageImage,
  SelectablePdfTextSpan,
  SelectionDragState,
  ToolbarButtonMap,
  VisibleInkTool
} from "./annotationTypes";

export type { AnnotationViewState } from "./annotationTypes";

type MarkdownTextLayerItem = PdfTextLayerItem & {
  index: number;
};

type MarkdownTextSelectionHoldState = {
  pointerId: number;
  start: PagePoint;
  current: PagePoint;
  startItem: MarkdownTextLayerItem;
  startClientX: number;
  startClientY: number;
  target: HTMLElement;
  timer: number;
  activated: boolean;
};

type PdfPendingTextSelectionState = {
  pointerId: number;
  pageNumber: number;
  start: PagePoint;
  current: PagePoint;
  token: number;
  released: boolean;
};







const MARKDOWN_TEXT_SELECTION_MOUSE_HOLD_MS = 80;
const MARKDOWN_TEXT_SELECTION_TOUCH_HOLD_MS = 150;
const MARKDOWN_TEXT_SELECTION_MOVE_TOLERANCE_PX = 12;

export class AnnotationView extends FileView {
  private sourcePath = "";
  private previousWritingTool: "pen" | "highlighter" = "pen";
  private saveErrorEl: HTMLElement | null = null;
  private onToolbarOutsideDismiss = (event: Event): void => this.dismissToolbarPopoverFromEvent(event);
  private returningToSource = false;
  private standalone = false;
  private rootEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private pageFrameEl: HTMLElement | null = null;
  private pageEl: HTMLElement | null = null;
  private selectionLayerEl: HTMLElement | null = null;
  private selectionBoxEl: HTMLElement | null = null;
  private captureBoxEl: HTMLElement | null = null;
  private selectionMenuEl: HTMLElement | null = null;
  private captureMenuEl: HTMLElement | null = null;
  private pdfTextMenuEl: HTMLElement | null = null;
  private pdfAnnotationMenuEl: HTMLElement | null = null;
  private selectionMarqueeEl: HTMLElement | null = null;
  private backgroundEl: HTMLElement | null = null;
  private markdownTextAnnotationLayerEl: HTMLElement | null = null;
  private committedCanvas: HTMLCanvasElement | null = null;
  private liveCanvas: HTMLCanvasElement | null = null;
  private engine: InkController | null = null;
  private saveQueue: SaveQueue | null = null;
  private annotation: AnnotationFile | null = null;
  private savedMarkdownLayout: MarkdownLayoutSnapshot | null = null;
  private currentMarkdownLayout: MarkdownLayoutSnapshot | null = null;
  private currentMarkdownSourceHash: string | null = null;
  private pdfTextAnnotations: PdfTextAnnotation[] = [];
  private pdfTextSelection: PdfTextSelectionState | null = null;
  private pdfTextDragSelection: PdfTextDragSelectionState | null = null;
  private pdfPendingTextSelection: PdfPendingTextSelectionState | null = null;
  private activePdfTextTouchId: number | null = null;
  private markdownTextItems: MarkdownTextLayerItem[] = [];
  private markdownTextSelectionHold: MarkdownTextSelectionHoldState | null = null;
  private pdfTextSelectionIsCustom = false;
  private activePdfTextAnnotationId: string | null = null;
  private pdfTextAnnotationColors: Record<PdfTextAnnotationKind, string> = {
    highlight: PDF_TEXT_HIGHLIGHT_COLOR,
    underline: PDF_TEXT_UNDERLINE_COLOR,
    strikethrough: PDF_TEXT_STRIKETHROUGH_COLOR,
    note: PDF_TEXT_NOTE_COLOR
  };
  private toolbarButtons: ToolbarButtonMap = {};
  private titlebarActionsInstalled = false;
  private toolbarEl: HTMLElement | null = null;
  private colorPaletteEl: HTMLElement | null = null;
  private widthPanelEl: HTMLElement | null = null;
  private eraserPanelEl: HTMLElement | null = null;
  private morePanelEl: HTMLElement | null = null;
  private stickerPanelEl: HTMLElement | null = null;
  private currentColorDot: HTMLElement | null = null;
  private customColorInput: HTMLInputElement | null = null;
  private widthRangeInput: HTMLInputElement | null = null;
  private widthNumberInput: HTMLInputElement | null = null;
  private widthPreviewLine: HTMLElement | null = null;
  private colorButtons = new Map<string, HTMLButtonElement>();
  private toolbarCollapsed = false;
  private toolbarPosition: { left: number; top: number } | null = null;
  private browseMode = false;
  private selectMode = false;
  private strokeSelectMode = false;
  private captureMode = false;
  private captureRect: PageRect | null = null;
  private selectedStrokeIds = new Set<string>();
  private selectionDrag: SelectionDragState | null = null;
  private selectionTouchId: number | null = null;
  private pinchZoomState: PinchZoomState | null = null;
  private strokeClipboard: InkStroke[] = [];
  private pasteSequence = 0;
  private paletteOpen = false;
  private widthPanelOpen = false;
  private eraserPanelOpen = false;
  private morePanelOpen = false;
  private stickerPanelOpen = false;
  private suppressToolbarClick = false;
  private rendering = false;
  private exportingPdf = false;
  private pdfRenderToken = 0;
  private pdfScrollEl: HTMLElement | null = null;
  private pdfBackgroundDocument: PdfJsDocument | null = null;
  private pdfBackgroundTargetWidth = 1;
  private pdfBackgroundPages: PdfBackgroundPageEntry[] = [];
  private pdfPageObserver: IntersectionObserver | null = null;
  private pdfObservedNearPages = new Set<number>();
  private pdfLazyRenderRaf: number | null = null;
  private pdfSharpRenderTimer: number | null = null;
  private pdfCleanupTimer: number | null = null;
  private pdfTextSelectionRefreshTimer: number | null = null;
  private pdfVisibleRenderRunning = false;
  private pdfVisibleRenderQueued = false;
  private pdfSharpRenderRunning = false;
  private toolbarOutsideDismissInstalled = false;
  private pdfInteractionBusyUntil = 0;
  private inkScaleRaf: number | null = null;
  private inkSharpTimer: number | null = null;
  private inkInteractionActive = false;
  private zoom = 1;
  private pageLogicalWidth = 1;
  private pageLogicalHeight = 1;
  /** Number of pages in the current standalone note (multi-page mode) */
  private standalonePageCount = 1;
  /** Per-page element containers for multi-page standalone notes */
  private standalonePageEls: HTMLElement[] = [];
  /** Inner scaled wrapper for multi-page standalone notes (equiv to pageEl in single-page) */
  private standaloneContentEl: HTMLElement | null = null;
  private standaloneObjectLayerEls = new Map<number, HTMLElement>();
  private selectedStandaloneElementId: string | null = null;
  private standaloneElementDrag: any | null = null;
  private readonly toolbarPositionStorageKey = "mobile-ink-annotation-toolbar-position";
  private readonly pdfPageNavigator = new PdfPageNavigatorManager({
    getPages: () => this.getPdfPageNavigatorPages(),
    getVisibleRange: () => this.getVisibleLogicalYRange(),
    onGoToPage: (pageNumber) => this.goToPdfPage(pageNumber)
  });

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MobileInkAnnotationPlugin
  ) {
    super(leaf);
    this.containerEl.addClass("note-ink-view");
  }

  getViewType(): string {
    return VIEW_TYPE_MOBILE_INK;
  }

  getDisplayText(): string {
    const name = this.sourcePath ? this.sourcePath.split("/").pop() : "Note Ink";
    return this.standalone ? `手書き： ${name}` : `注釈： ${name}`;
  }

  getIcon(): string {
    return "pencil";
  }

  onPaneMenu(menu: Menu, source: "more-options" | "tab-header" | string): void {
    super.onPaneMenu(menu, source);
    if (source !== "more-options") return;

    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("注釈を保存")
        .setIcon("save")
        .onClick(() => {
          void this.saveCurrentAnnotation().catch(error => console.error("Note Ink: save failed", error));
        });
    });

    if (this.standalone) {
      menu.addItem((item) => {
        item
          .setTitle("画像を追加")
          .setIcon("image-plus")
          .onClick(() => {
            ((...args: any[]) => (null as any))();
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("図形を追加")
          .setIcon("shapes");
          
        if (typeof (item as any).setSubmenu === "function") {
          const sub = (item as any).setSubmenu();
          const shapes: Array<{ kind: StandaloneShapeKind; label: string; icon: string }> = [
            { kind: "note", label: "付箋", icon: "sticky-note" },
            { kind: "rect", label: "四角形", icon: "square" },
            { kind: "ellipse", label: "円", icon: "circle" },
            { kind: "line", label: "線", icon: "minus" }
          ];
          for (const shape of shapes) {
            sub.addItem((subItem: any) => {
              subItem
                .setTitle(shape.label)
                .setIcon(shape.icon)
                .onClick(() => ((...args: any[]) => (null as any))(shape.kind));
            });
          }
        } else {
          item.onClick((event) => {
            ((...args: any[]) => (null as any))(event as MouseEvent);
          });
        }
      });
      menu.addItem((item) => {
        item
          .setTitle("ステッカーを追加")
          .setIcon("sticker")
          .onClick((event) => {
            void ((...args: any[]) => (null as any))(event as MouseEvent);
          });
      });
    }

    if (this.standalone && this.annotation) {
      const templates: { id: StandaloneTemplate; name: string }[] = [
        { id: "blank", name: "白紙" },
        { id: "lined", name: "罫線" },
        { id: "grid", name: "方眼" },
        { id: "dotted", name: "ドット" },
        { id: "cornell", name: "コーネル式ノート" }
      ];
      const current = this.annotation.template || "blank";
      
      // Use sub-menu for templates
      menu.addItem((item) => {
        item
          .setTitle("用紙を変更")
          .setIcon("layout-template");
        
        if (typeof (item as any).setSubmenu === "function") {
          const subMenu = (item as any).setSubmenu() as Menu;
          templates.forEach(t => {
            subMenu.addItem(subItem => {
              subItem.setTitle(t.name)
                  .setChecked(current === t.id)
                  .onClick(() => {
                    this.annotation!.template = t.id;
                    this.saveQueue?.markDirty();
                    this.containerEl.querySelectorAll(".mobile-ink-standalone-background").forEach(bg => {
                      bg.setAttribute("data-template", t.id);
                    });
                  });
            });
          });
        } else {
          // Fallback if setSubmenu is not available
          templates.forEach(t => {
            menu.addItem(fallbackItem => {
              fallbackItem.setTitle(`  - ${t.name}`)
                  .setChecked(current === t.id)
                  .onClick(() => {
                    this.annotation!.template = t.id;
                    this.saveQueue?.markDirty();
                    this.containerEl.querySelectorAll(".mobile-ink-standalone-background").forEach(bg => {
                      bg.setAttribute("data-template", t.id);
                    });
                  });
            });
          });
        }
      });

      // Delete current page (only when there are multiple pages)
      if (this.standalonePageCount > 1) {
        const currentPageNumber = ((...args: any[]) => (null as any))();
        menu.addItem((item) => {
          item
            .setTitle(`${currentPageNumber}ページを削除`)
            .setIcon("trash-2")
            .onClick(() => {
              void ((...args: any[]) => (null as any))(currentPageNumber);
            });
        });
      }
    }

    if (false) {
      const state = this.engine?.getToolState();
      menu.addItem((item) => {
        item
          .setTitle(state?.acceptTouchInput ? "指での手書きをオフ" : "指での手書きをオン")
          .setIcon("hand")
          .setChecked(state?.acceptTouchInput ?? false)
          .onClick(() => ((...args: any[]) => (null as any))());
      });
    }

    if (this.isPdfPath(this.sourcePath)) {
      menu.addItem((item) => {
        item
          .setTitle("書き込み入りPDFを保存")
          .setIcon("file-down")
          .setDisabled(this.exportingPdf)
          .onClick(() => {
            void this.exportPdfCopy();
          });
      });
    }

    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("注釈画面を閉じる")
        .setIcon("x")
        .onClick(() => {
          void this.exitAnnotationView().catch(error => console.error("Note Ink: close failed", error));
        });
    });
  }

  canAcceptExtension(extension: string): boolean {
    return extension === STANDALONE_INK_EXTENSION || extension === "pdf";
  }

  

  private isPdfPath(path: string): boolean {
    return path.toLowerCase().endsWith(".pdf");
  }

  async setState(state: AnnotationViewState, result: ViewStateResult): Promise<void> {
    const nextSourcePath = state.sourcePath ?? state.file ?? this.file?.path ?? "";
    if (nextSourcePath && nextSourcePath !== this.sourcePath) {
      await this.flushCurrentWork();
    }

    await super.setState(state, result);
    this.sourcePath = nextSourcePath || this.file?.path || "";
    this.standalone = false;
    if (typeof state.zoom === "number" && Number.isFinite(state.zoom)) {
      this.zoom = this.clampZoom(state.zoom);
    }
    if (this.contentEl.isConnected) {
      await this.render();
    }
  }

  getState(): AnnotationViewState {
    return {
      ...super.getState(),
      file: this.sourcePath,
      sourcePath: this.sourcePath,
      standalone: this.standalone,
      zoom: this.zoom
    };
  }

  async onLoadFile(file: TFile): Promise<void> {
    if (file.path !== this.sourcePath) {
      await this.flushCurrentWork();
    }

    this.sourcePath = file.path;
    this.standalone = false;
    if (this.contentEl.isConnected) {
      await this.render();
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.flushCurrentWork();
    this.detachPdfLazyRenderer();
    this.detachPdfPageNavigator();
    this.cancelInkDisplayScaleUpdate();
    this.scrollEl?.removeEventListener("scroll", this.onAnnotationScroll);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.removeToolbarOutsideDismiss();
    this.engine?.destroy();
    this.engine = null;
  }

  async onOpen(): Promise<void> {
    this.ensureTitlebarActions();
    if(!this.rootEl?.isConnected)await this.render();
    this.refreshToolbarState();
  }

  async onClose(): Promise<void> {
    await this.flushCurrentWork();
    this.detachPdfLazyRenderer();
    this.detachPdfPageNavigator();
    this.cancelInkDisplayScaleUpdate();
    this.cancelPdfTextSelectionRefresh();
    this.scrollEl?.removeEventListener("scroll", this.onAnnotationScroll);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    document.removeEventListener("selectionchange", this.onPdfTextDocumentSelectionChange);
    this.removeToolbarOutsideDismiss();
    this.engine?.destroy();
    this.engine = null;
  }

  private async flushCurrentWork(): Promise<void> {
    this.engine?.flushPendingStrokes();
    if (this.saveQueue) {
      await this.saveQueue.flush();
    }
  }

  private installToolbarOutsideDismiss(): void {
    if (this.toolbarOutsideDismissInstalled) return;

    document.addEventListener("pointerdown", this.onToolbarOutsideDismiss, true);
    document.addEventListener("touchstart", this.onToolbarOutsideDismiss, true);
    this.toolbarOutsideDismissInstalled = true;
  }

  private removeToolbarOutsideDismiss(): void {
    if (!this.toolbarOutsideDismissInstalled) return;

    document.removeEventListener("pointerdown", this.onToolbarOutsideDismiss, true);
    document.removeEventListener("touchstart", this.onToolbarOutsideDismiss, true);
    this.toolbarOutsideDismissInstalled = false;
  }

  

  

  private dismissToolbarPopoverFromEvent(event: Event): void {
    if (!this.hasOpenToolbarPopover()) return;

    const target = event.target;
    if (target instanceof Element && target.closest(".mobile-ink-toolbar")) return;
    this.closeToolbarPopovers();
  }

  private async render(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;

    try {
      await this.flushCurrentWork();
      this.detachPdfLazyRenderer();
      this.detachPdfPageNavigator();
      this.cancelInkDisplayScaleUpdate();
      this.cancelPdfTextSelectionRefresh();
      this.scrollEl?.removeEventListener("scroll", this.onAnnotationScroll);
      document.removeEventListener("keydown", this.onDocumentKeyDown, true);
      document.removeEventListener("selectionchange", this.onPdfTextDocumentSelectionChange);
      this.removeToolbarOutsideDismiss();
      this.engine?.destroy();
      this.engine = null;
      this.saveQueue = null;
      this.annotation = null;
      this.resetFloatingToolbarButtons();
      this.toolbarEl = null;
      this.colorPaletteEl = null;
      this.widthPanelEl = null;
      this.eraserPanelEl = null;
      this.morePanelEl = null;
      this.stickerPanelEl = null;
      this.pageFrameEl = null;
      this.standaloneContentEl = null;
      this.standalonePageEls = [];
      this.standaloneObjectLayerEls.clear();
      this.selectedStandaloneElementId = null;
      this.standaloneElementDrag = null;
      this.selectionLayerEl = null;
      this.selectionBoxEl = null;
      this.captureBoxEl = null;
      this.selectionMenuEl = null;
      this.captureMenuEl = null;
      this.pdfTextMenuEl = null;
      this.pdfAnnotationMenuEl = null;
      this.selectionMarqueeEl = null;
      this.markdownTextAnnotationLayerEl = null;
      this.currentColorDot = null;
      this.customColorInput = null;
      this.widthRangeInput = null;
      this.widthNumberInput = null;
      this.widthPreviewLine = null;
      this.colorButtons.clear();
      this.browseMode = false;
      this.selectMode = false;
      this.strokeSelectMode = false;
      this.captureMode = false;
      this.captureRect = null;
      this.selectedStrokeIds.clear();
      this.pdfTextAnnotations = [];
      this.markdownTextItems = [];
      this.clearMarkdownTextSelectionHold();
      this.savedMarkdownLayout = null;
      this.currentMarkdownLayout = null;
      this.currentMarkdownSourceHash = null;
      this.pdfTextSelection = null;
      this.pdfTextDragSelection = null;
      this.pdfTextSelectionIsCustom = false;
      this.activePdfTextAnnotationId = null;
      this.selectionDrag = null;
      this.selectionTouchId = null;
      this.pinchZoomState = null;
      this.paletteOpen = false;
      this.widthPanelOpen = false;
      this.eraserPanelOpen = false;
      this.morePanelOpen = false;
      this.contentEl.empty();

      if (!this.sourcePath) {
        this.contentEl.createDiv({ cls: "mobile-ink-status", text: "注釈を付けるファイルが指定されていません。" });
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
      if (!(file instanceof TFile)) {
        this.contentEl.createDiv({ cls: "mobile-ink-status", text: `ファイルが見つかりません：${this.sourcePath}` });
        return;
      }

      const root = this.contentEl.createDiv({ cls: "mobile-ink-root" });
      root.tabIndex = -1;
      this.rootEl = root;
      this.installInputGuards(root);
      document.addEventListener("keydown", this.onDocumentKeyDown, true);
      document.addEventListener("selectionchange", this.onPdfTextDocumentSelectionChange);
      this.installToolbarOutsideDismiss();
      this.createToolbar(root);

      const stage = root.createDiv({ cls: "mobile-ink-stage" });
      const scroll = stage.createDiv({ cls: "mobile-ink-scroll" });
      scroll.addEventListener("scroll", this.onAnnotationScroll, { passive: true });
      const pageFrame = scroll.createDiv({ cls: "mobile-ink-page-frame" });
      const page = pageFrame.createDiv({ cls: "mobile-ink-page" });
      const background = page.createDiv({ cls: "mobile-ink-background markdown-preview-view" });
      background.addEventListener("pointerdown", ((...args: any[]) => (null as any)));
      background.addEventListener("pointermove", ((...args: any[]) => (null as any)));
      background.addEventListener("pointerup", ((...args: any[]) => (null as any)));
      background.addEventListener("pointercancel", ((...args: any[]) => (null as any)));
      const markdownTextAnnotationLayer = page.createDiv({ cls: "mobile-ink-markdown-text-annotation-layer" });
      const committed = page.createEl("canvas", { cls: "mobile-ink-committed-canvas" });
      const live = page.createEl("canvas", { cls: "mobile-ink-live-canvas", attr: { "aria-label": "手書きエリア" } });
      const selectionLayer = page.createDiv({ cls: "mobile-ink-selection-layer", attr: { "aria-label": "注釈の選択エリア" } });
      const selectionMarquee = selectionLayer.createDiv({ cls: "mobile-ink-selection-marquee" });
      const selectionBox = selectionLayer.createDiv({ cls: "mobile-ink-selection-box" });
      const captureBox = selectionLayer.createDiv({ cls: "mobile-ink-capture-box" });
      const selectionMenu = selectionLayer.createDiv({ cls: "mobile-ink-selection-menu" });
      const captureMenu = selectionLayer.createDiv({ cls: "mobile-ink-selection-menu mobile-ink-capture-menu" });
      const pdfTextMenu = selectionLayer.createDiv({ cls: "mobile-ink-selection-menu mobile-ink-pdf-text-menu" });
      const pdfAnnotationMenu = selectionLayer.createDiv({ cls: "mobile-ink-selection-menu mobile-ink-pdf-annotation-menu" });
      stage.createDiv({ cls: "mobile-ink-input-shield", attr: { "aria-label": "ペン入力エリア" } });

      this.scrollEl = scroll;
      this.pageFrameEl = pageFrame;
      this.pageEl = page;
      this.selectionLayerEl = selectionLayer;
      this.selectionMarqueeEl = selectionMarquee;
      this.selectionBoxEl = selectionBox;
      this.captureBoxEl = captureBox;
      this.selectionMenuEl = selectionMenu;
      this.captureMenuEl = captureMenu;
      this.pdfTextMenuEl = pdfTextMenu;
      this.pdfAnnotationMenuEl = pdfAnnotationMenu;
      this.markdownTextAnnotationLayerEl = markdownTextAnnotationLayer;
      this.createSelectionMenu(selectionMenu);
      this.createCaptureMenu(captureMenu);
      this.createPdfAnnotationMenu(pdfAnnotationMenu);
      this.backgroundEl = background;
      this.committedCanvas = committed;
      this.liveCanvas = live;

      const isPdfSource = this.isPdfPath(file.path);
      page.classList.toggle("mobile-ink-pdf-page-mode", isPdfSource);

      const pageSize = this.standalone
        ? await ((...args: any[]) => (null as any))(file, scroll, page, background)
        : isPdfSource
          ? await this.setupPdfPage(file, scroll, page, background)
          : await this.setupMarkdownPage(file, scroll, page, background);
      if (isPdfSource) {
        this.pdfPageNavigator.mount(root);
      }
      this.applyZoom();
      this.installZoomHandlers(scroll);
      this.installSelectionHandlers(selectionLayer);
      this.saveQueue = new SaveQueue(() => this.saveNow(),800,() => this.showSaveError(),() => {this.saveErrorEl?.remove();this.saveErrorEl=null;});

      const useTiledInk = !isPdfSource && this.shouldUseTiledInk(pageSize);
      page.classList.toggle("mobile-ink-tiled-ink-mode", useTiledInk);
      this.engine = isPdfSource
        ? this.createPdfInkController(scroll)
        : this.standalone
          ? this.createStandaloneMultiPageInkController(scroll, pageSize)
          : useTiledInk
            ? this.createTiledInkController(scroll, page, pageSize)
            : new InkEngine(live, committed, scroll, {
              initialToolState: this.createInitialInkToolState(),
              canvasMaxDpr: this.isMobileLike() ? 3 : 3.75,
              canvasMaxPixels: this.isMobileLike() ? 4_000_000 : 8_000_000,
              onInputStart: () => this.enterInkInteractionMode(),
              onInputEnd: () => this.scheduleInkSharpDisplayScaleUpdate(),
              onChange: () => {
                this.saveQueue?.markDirty();
                this.refreshToolbarState();
              }
            });

      this.engine.resize(pageSize.width, pageSize.height);
      this.engine.setDisplayScale(this.getInkDisplayScale());
      const loadedAnnotation = this.annotation as AnnotationFile | null;
      if (loadedAnnotation) {
        if (this.standalone && this.engine instanceof PageInkController) {
          // Multi-page: load strokes per page
          const annoPages = loadedAnnotation.pages && loadedAnnotation.pages.length > 0
            ? loadedAnnotation.pages
            : [{ pageNumber: 1, strokes: loadedAnnotation.strokes }];
          
          // PageInkController uses getStrokes() / loadStrokes() per page via pageNumber offset
          // We need to flatten with offset-Y adjusted coords per page – the engine's tiling
          // already handles this: each tile tracks its offsetY, so we load strokes for each page
          // segment. For multi-page we just load them as one flat set (already offset by page).
          const allStrokes = annoPages.flatMap(p => p.strokes);
          this.engine.loadStrokes(allStrokes);
        } else {
          const strokes = isPdfSource
            ? this.preparePdfInkStrokesForCurrentLayout(
              loadedAnnotation.strokes,
              loadedAnnotation.pageWidth,
              loadedAnnotation.pageHeight
            )
            : this.prepareMarkdownInkStrokesForCurrentLayout(
              loadedAnnotation.strokes,
              loadedAnnotation.pageWidth,
              loadedAnnotation.pageHeight
            );
          this.engine.loadStrokes(strokes);
        }
      }
      this.refreshToolbarState();
    } catch (error) {
      console.error("Note Ink: cannot open annotation view", error);
      this.engine?.destroy(); this.engine=null;
      this.contentEl.empty();
      this.contentEl.createDiv({cls:"mobile-ink-status",text:error instanceof Error ? error.message : "ファイルを開けませんでした。"});
    } finally {
      this.rendering = false;
    }
  }

  private createPdfInkController(scroll: HTMLElement): InkController {
    const pages: PageInkDescriptor[] = this.pdfBackgroundPages.map((entry) => ({
      pageNumber: entry.pageNumber,
      pageEl: entry.pageEl,
      width: Math.max(1, Math.ceil(entry.viewport.width)),
      height: Math.max(1, Math.ceil(entry.viewport.height)),
      offsetY: entry.offsetY
    }));

    return new PageInkController(pages, {
      scrollEl: scroll,
      initialToolState: this.createInitialInkToolState(),
      panOutsideCanvas: false,
      keepMarginPx: this.isMobileLike() ? 160 : 520,
      releaseMarginPx: this.isMobileLike() ? 620 : 1300,
      getVisibleRange: () => this.getVisibleLogicalYRange(),
      onInputStart: () => this.enterInkInteractionMode(),
      onInputEnd: () => this.scheduleInkSharpDisplayScaleUpdate(),
      onChange: () => {
        this.saveQueue?.markDirty();
        this.refreshToolbarState();
      }
    });
  }

  private createTiledInkController(scroll: HTMLElement, page: HTMLElement, pageSize: { width: number; height: number }): InkController {
    const tileHeight = this.isMobileLike() ? MARKDOWN_TILED_INK_MOBILE_TILE_HEIGHT : MARKDOWN_TILED_INK_DESKTOP_TILE_HEIGHT;
    const tileOverlap = this.isMobileLike() ? 48 : 96;
    const pages: PageInkDescriptor[] = [];
    let offsetY = 0;
    let index = 1;

    while (offsetY < pageSize.height) {
      const height = Math.max(1, Math.min(tileHeight, pageSize.height - offsetY));
      const drawTop = Math.max(0, offsetY - tileOverlap);
      const drawBottom = Math.min(pageSize.height, offsetY + height + tileOverlap);
      const drawHeight = Math.max(1, drawBottom - drawTop);
      const tile = page.createDiv({
        cls: "mobile-ink-ink-tile",
        attr: { "aria-hidden": "true" }
      });
      tile.style.left = "0px";
      tile.style.top = `${drawTop}px`;
      tile.style.width = `${pageSize.width}px`;
      tile.style.height = `${drawHeight}px`;

      pages.push({
        pageNumber: index,
        pageEl: tile,
        width: pageSize.width,
        height: drawHeight,
        offsetY: drawTop,
        inputTop: offsetY - drawTop,
        inputBottom: offsetY + height - drawTop
      });

      offsetY += height;
      index++;
    }

    return new PageInkController(pages, {
      scrollEl: scroll,
      initialToolState: this.createInitialInkToolState(),
      recoverPointerOnMove: false,
      panOutsideCanvas: false,
      keepMarginPx: this.isMobileLike() ? 120 : 300,
      releaseMarginPx: this.isMobileLike() ? 950 : 1700,
      getVisibleRange: () => this.getVisibleLogicalYRange(),
      onInputStart: () => this.enterInkInteractionMode(),
      onInputEnd: () => this.scheduleInkSharpDisplayScaleUpdate(),
      onChange: () => {
        this.saveQueue?.markDirty();
        this.refreshToolbarState();
      }
    });
  }

  /** Build tile descriptors for one standalone page.
   * All tiles are added as absolute-positioned children of 'container' (pageFrame),
   * using global Y offsets so PageInkController can correctly map scroll position to tiles.
   */
  private buildTileDescriptors(
    container: HTMLElement,
    startPageNumber: number,
    pageWidth: number,
    pageHeight: number,
    baseOffsetY: number,
    tileHeight: number,
    tileOverlap: number
  ): PageInkDescriptor[] {
    const tiles: PageInkDescriptor[] = [];
    let localY = 0;
    let index = startPageNumber * 1000; // unique tile index per page (1000-series per page)

    while (localY < pageHeight) {
      const height = Math.max(1, Math.min(tileHeight, pageHeight - localY));
      // No overlap at page top/bottom boundaries to avoid bleeding into gaps
      const drawTop = Math.max(0, localY - tileOverlap);
      const drawBottom = Math.min(pageHeight, localY + height + tileOverlap);
      const drawHeight = Math.max(1, drawBottom - drawTop);

      const tile = container.createDiv({
        cls: "mobile-ink-ink-tile",
        attr: { "aria-hidden": "true" }
      });
      tile.style.left = "0px";
      tile.style.top = `${baseOffsetY + drawTop}px`;
      tile.style.width = `${pageWidth}px`;
      tile.style.height = `${drawHeight}px`;

      tiles.push({
        pageNumber: index,
        pageEl: tile,
        width: pageWidth,
        height: drawHeight,
        offsetY: baseOffsetY + drawTop,
        inputTop: localY - drawTop,
        inputBottom: localY + height - drawTop
      });

      localY += height;
      index++;
    }
    return tiles;
  }

  /** Create a multi-page ink controller for standalone notes */
  private createStandaloneMultiPageInkController(
    scroll: HTMLElement,
    totalSize: { width: number; height: number }
  ): InkController {
    const tileHeight = this.isMobileLike() ? MARKDOWN_TILED_INK_MOBILE_TILE_HEIGHT : MARKDOWN_TILED_INK_DESKTOP_TILE_HEIGHT;
    const pageGap = 24;
    const allTiles: PageInkDescriptor[] = [];

    // Single page height from stored annotation
    const pageH = this.annotation
      ? Math.max(480, Math.ceil(this.annotation.pageHeight || totalSize.height))
      : totalSize.height;

    // All tiles are placed inside standaloneContentEl (the scaled wrapper)
    const contentEl = this.standaloneContentEl;
    if (!contentEl) return new PageInkController([], {
      scrollEl: scroll,
      initialToolState: this.createInitialInkToolState(),
      onChange: () => { this.saveQueue?.markDirty(); this.refreshToolbarState(); }
    });

    // Use one tile per physical page (tileHeight = pageH).
    // This eliminates all within-page tile boundaries and prevents live-drawing gaps
    // that occur when a stroke crosses a tile boundary.
    for (let i = 0; i < this.standalonePageEls.length; i++) {
      const baseOffsetY = pageH * i + pageGap * i;
      const tiles = this.buildTileDescriptors(contentEl, i + 1, totalSize.width, pageH, baseOffsetY, pageH, 0);
      allTiles.push(...tiles);
    }

    return new PageInkController(allTiles, {
      scrollEl: scroll,
      initialToolState: this.createInitialInkToolState(),
      recoverPointerOnMove: false,
      panOutsideCanvas: false,
      keepMarginPx: this.isMobileLike() ? 120 : 300,
      releaseMarginPx: this.isMobileLike() ? 950 : 1700,
      getVisibleRange: () => this.getVisibleLogicalYRange(),
      onInputStart: () => this.enterInkInteractionMode(),
      onInputEnd: () => this.scheduleInkSharpDisplayScaleUpdate(),
      onChange: () => {
        this.saveQueue?.markDirty();
        this.refreshToolbarState();
      }
    });
  }


  private shouldUseTiledInk(pageSize: { width: number; height: number }): boolean {
    return true; // 强制启用切片渲染，防止全局 Canvas 在高拡大倍数和频繁重绘时爆内存
  }

  private createInitialInkToolState() {
    return {
      tool: "pen" as const,
      color: "#111111",
      width: 2,
      highlighterColor: "#ffd54a",
      highlighterWidth: 14,
      eraserRadius: 18,
      acceptTouchInput: false
    };
  }

  private ensureTitlebarActions():void {
    if(this.titlebarActionsInstalled)return;
    this.titlebarActionsInstalled=true;
    this.toolbarButtons.exit=this.createTitlebarAction('arrow-left','元のPDFに戻る',()=>this.exitAnnotationView());
    this.toolbarButtons.exportPdf=this.createTitlebarAction('file-down','書き込み入りPDFを書き出す',()=>this.exportPdfCopy());
  }

  private createTitlebarAction(icon: string, title: string, onClick: (event: MouseEvent) => void | Promise<void>): HTMLElement {
    const action = this.addAction(icon, title, (event) => {
      event.preventDefault();
      this.closeToolbarPopovers();
      Promise.resolve(onClick(event)).catch(error => console.error("Note Ink: action failed", error));
    });
    action.addClass("mobile-ink-titlebar-action");
    return action;
  }

  async exportPdfCopy(): Promise<void> {
    if (this.exportingPdf || !this.isPdfPath(this.sourcePath) || !this.engine || !this.pdfBackgroundDocument) return;
    this.exportingPdf = true;
    this.setMorePanelOpen(false);
    this.refreshToolbarState();
    const notice = new Notice("書き込み入りPDFを作成しています…", 0);
    const sourcePath = this.sourcePath;
    const pdf = this.pdfBackgroundDocument;
    const engine = this.engine;
    const entries = this.pdfBackgroundPages.map(entry => ({...entry}));
    const targetWidth = this.pdfBackgroundTargetWidth;
    try {
      this.engine.flushPendingStrokes();
      await this.saveQueue?.flush();
      if (this.sourcePath !== sourcePath || this.engine !== engine || this.pdfBackgroundDocument !== pdf) {
        throw new Error("保存中に表示するPDFが変わりました。元のPDFを開いて、もう一度保存してください。");
      }
      const strokes = structuredClone(engine.getStrokes());
      const annotations = structuredClone(this.pdfTextAnnotations);
      // Use the exact bytes being viewed: an external edit cannot misalign the export.
      const source = await pdf.getData();
      const layouts: ExportPage[] = [];
      for (const entry of entries) {
        const width = Math.ceil(entry.viewport.width), height = Math.ceil(entry.viewport.height);
        const page = await pdf.getPage(entry.pageNumber);
        const base = page.getViewport({scale:1});
        const scale = Math.min(targetWidth / Math.max(1,base.width), height / Math.max(1,base.height));
        const view = page.getViewport({scale});
        if (!view.transform) throw new Error("PDFのページ座標を読み取れません。");
        const transform = [...view.transform] as ExportPage["transform"];
        transform[4] += Math.max(0,(width-view.width)/2);
        transform[5] += Math.max(0,(height-view.height)/2);
        layouts.push({pageNumber:entry.pageNumber,width,height,offsetY:entry.offsetY,transform});
      }
      const bytes = await exportAnnotatedPdf(source,layouts,strokes,annotations,
        (done,total) => notice.setMessage(`PDFを作成しています… ${done}/${total}ページ`));
      const path = await saveExportCopy(this.app.vault,sourcePath,bytes);
      notice.setMessage(`保存しました：${path}\n元のPDFはそのまま残っています。`);
      window.setTimeout(()=>notice.hide(),8000);
    } catch (error) {
      console.error("Note Ink: PDF export failed",error);
      notice.hide();
      new Notice(`PDFを保存できませんでした。${error instanceof Error ? error.message : "空き容量と保存先を確認してください。"}`,10000);
    } finally {
      this.exportingPdf = false;
      this.refreshToolbarState();
    }
  }

  private async saveCurrentAnnotation(): Promise<void> {
    await this.flushCurrentWork();
    new Notice("注釈を保存しました。");
  }

  private showSaveError():void {
    if(this.saveErrorEl?.isConnected)return;
    const box=this.contentEl.createDiv({cls:'note-ink-save-error',attr:{role:'alert'}});
    box.createSpan({text:'注釈を保存できませんでした。空き容量と保存先を確認してください。'});
    const retry=box.createEl('button',{text:'再試行',attr:{type:'button'}});
    retry.addEventListener('click',async()=>{
      retry.disabled=true;
      try {await this.flushCurrentWork();}catch { /* The dirty annotation remains available for another retry. */ }
      finally {retry.disabled=false;}
    });
    this.saveErrorEl=box;
  }
  private async exitAnnotationView():Promise<void> {
    if(this.returningToSource)return;
    const file=this.app.vault.getAbstractFileByPath(this.sourcePath);
    if(!(file instanceof TFile)){new Notice('元のファイルが見つかりません。');return;}
    this.returningToSource=true;
    try {
      this.engine?.setInputEnabled(false);
      await this.flushCurrentWork();
      await this.plugin.openSourceWithoutAnnotation(file,this.leaf);
    } catch(error) {
      this.syncInkInputEnabled();
      new Notice('元のファイルに戻れませんでした。注釈画面を保持しています。');
      throw error;
    } finally {this.returningToSource=false;}
  }
  private resetFloatingToolbarButtons():void {
    this.toolbarButtons={exportPdf:this.toolbarButtons.exportPdf,exit:this.toolbarButtons.exit};
  }

  private createToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({
      cls: "mobile-ink-toolbar",
      attr: { "aria-label": "注釈ツールバー" }
    });
    this.toolbarEl = toolbar;

    const dock = toolbar.createDiv({ cls: "mobile-ink-toolbar-dock" });
    const dragHandle = dock.createDiv({
      cls: "mobile-ink-drag-handle",
      attr: {
        "aria-label": "ツールバーを移動",
        title: "ツールバーを移動"
      }
    });
    this.bindToolbarDrag(dragHandle);

    const toolGroup = this.createToolbarGroup(dock);
    this.toolbarButtons.pen = this.createToolButton(toolGroup, "pencil", "ペン", () => this.setTool("pen"));
    this.toolbarButtons.highlighter = this.createToolButton(toolGroup, "highlighter", "蛍光ペン", () => this.setTool("highlighter"));
    this.toolbarButtons.eraser = this.createToolButton(toolGroup, "eraser", "消しゴム", () => this.activateEraser());
    if (false) {
      this.toolbarButtons.strokeSelect = this.createIconButton(toolGroup, "scan", "手書きを選択", () => ((...args: any[]) => (null as any))(!this.strokeSelectMode));
    }
    if (false) {
      this.toolbarButtons.capture = this.createIconButton(toolGroup, "scan-search", "範囲を画像にする", () => ((...args: any[]) => (null as any))(!this.captureMode));
    }
    this.toolbarButtons.width = this.createIconButton(toolGroup, "sliders-horizontal", "線の太さ", () => this.setWidthPanelOpen(!this.widthPanelOpen));

    const colorGroup = this.createToolbarGroup(dock);
    this.toolbarButtons.palette = this.createCurrentColorButton(colorGroup);

    const actionGroup = this.createToolbarGroup(dock);
    this.toolbarButtons.undo=this.createIconButton(actionGroup,"undo-2","元に戻す",()=>this.undoCurrentAnnotation());
    this.toolbarButtons.redo=this.createIconButton(actionGroup,"redo-2","やり直す",()=>this.redoCurrentAnnotation());
    this.toolbarButtons.collapse = this.createIconButton(actionGroup, "chevron-down", "ツールバーを折りたたむ", () => this.setToolbarCollapsed(true));

    this.createColorPalette(toolbar);
    this.createWidthPanel(toolbar);
    this.createEraserPanel(toolbar);

    this.toolbarButtons.expand = this.createIconButton(toolbar, "pencil", "ツールバーを開く", () => this.setToolbarCollapsed(false));
    this.toolbarButtons.expand.classList.add("mobile-ink-floating-button");
    this.bindToolbarDrag(this.toolbarButtons.expand);
    this.restoreToolbarPosition();
    requestAnimationFrame(() => {
      if (!this.toolbarPosition) return;
      this.setToolbarPosition(this.toolbarPosition.left, this.toolbarPosition.top);
    });
  }

  private createToolbarGroup(parent: HTMLElement): HTMLElement {
    return parent.createDiv({ cls: "mobile-ink-toolbar-group" });
  }

  private createIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "mobile-ink-icon-button",
      attr: {
        type: "button",
        "aria-label": label,
        title: label
      }
    });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.suppressToolbarClick) {
        this.suppressToolbarClick = false;
        return;
      }
      Promise.resolve(onClick()).catch(error => console.error("Note Ink: action failed", error));
    });
    return button;
  }

  private createToolButton(parent: HTMLElement, icon: string, label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    const button = this.createIconButton(parent, icon, label, onClick);
    button.classList.add("mobile-ink-tool-button");
    return button;
  }

  private createCurrentColorButton(parent: HTMLElement): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "mobile-ink-current-color-button",
      attr: {
        type: "button",
        "aria-label": "色を選ぶ",
        title: "色を選ぶ",
        "aria-expanded": "false"
      }
    });
    this.currentColorDot = button.createSpan({ cls: "mobile-ink-current-color-dot" });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setPaletteOpen(!this.paletteOpen);
    });
    return button;
  }

  private createColorPalette(parent: HTMLElement): void {
    const palette = parent.createDiv({
      cls: "mobile-ink-toolbar-popover mobile-ink-color-palette",
      attr: { "aria-label": "色を選ぶ" }
    });
    this.colorPaletteEl = palette;

    const swatches = palette.createDiv({ cls: "mobile-ink-color-swatches" });
    this.createColorButton(swatches, "黒", "#111111", () => this.setInkColor("#111111"));
    this.createColorButton(swatches, "青", "#1c7ed6", () => this.setInkColor("#1c7ed6"));
    this.createColorButton(swatches, "緑", "#40c057", () => this.setInkColor("#40c057"));
    this.createColorButton(swatches, "黄", "#fcc419", () => this.setInkColor("#fcc419"));
    this.createColorButton(swatches, "赤", "#fa343f", () => this.setInkColor("#fa343f"));
    this.createColorButton(swatches, "紫", "#9c36b5", () => this.setInkColor("#9c36b5"));

    const custom = palette.createDiv({ cls: "mobile-ink-custom-color" });
    const input = custom.createEl("input", {
      cls: "mobile-ink-color-input",
      attr: {
        type: "color",
        value: "#111111",
        "aria-label": "好きな色を選ぶ",
        title: "好きな色を選ぶ"
      }
    });
    input.addEventListener("input", () => {
      this.setInkColor(input.value);
    });
    this.customColorInput = input;
  }

  private createWidthPanel(parent: HTMLElement): void {
    const panel = parent.createDiv({
      cls: "mobile-ink-toolbar-popover mobile-ink-width-panel",
      attr: { "aria-label": "線の太さ" }
    });
    this.widthPanelEl = panel;

    const preview = panel.createDiv({ cls: "mobile-ink-width-preview" });
    this.widthPreviewLine = preview.createSpan({ cls: "mobile-ink-width-preview-line" });

    const controls = panel.createDiv({ cls: "mobile-ink-width-controls" });
    const range = controls.createEl("input", {
      cls: "mobile-ink-width-range",
      attr: {
        type: "range",
        min: "1",
        max: "36",
        step: "0.5",
        value: "2",
        "aria-label": "線の太さ"
      }
    });
    const number = controls.createEl("input", {
      cls: "mobile-ink-width-number",
      attr: {
        type: "number",
        min: "1",
        max: "36",
        step: "0.5",
        value: "2",
        "aria-label": "線の太さの値"
      }
    });

    range.addEventListener("input", () => this.setInkWidth(Number(range.value)));
    number.addEventListener("input", () => this.setInkWidth(Number(number.value)));
    this.widthRangeInput = range;
    this.widthNumberInput = number;
  }

  private createEraserPanel(parent: HTMLElement): void {
    const panel = parent.createDiv({
      cls: "mobile-ink-toolbar-popover mobile-ink-eraser-panel",
      attr: { "aria-label": "消しゴムの設定" }
    });
    this.eraserPanelEl = panel;

    this.createEraserOption(panel, "eraser", "消しゴム", () => {
      this.setTool("eraser", { allowToggleBrowse: false });
      this.setEraserPanelOpen(false);
    });
    if (this.plugin.hasFeature("clearAllAnnotations")) {
      this.toolbarButtons.clearAll = this.createEraserOption(panel, "trash-2", "注釈をすべて削除", async () => {
        await this.confirmAndClearAll();
      });
      this.toolbarButtons.clearAll.classList.add("mobile-ink-danger-option");
    }
  }

  private createEraserOption(parent: HTMLElement, icon: string, label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "mobile-ink-eraser-option",
      attr: {
        type: "button",
        "aria-label": label,
        title: label
      }
    });
    setIcon(button, icon);
    button.createSpan({ text: label });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(onClick()).catch(error => console.error("Note Ink: action failed", error));
    });
    return button;
  }

  private createSelectionMenu(menu: HTMLElement): void {
    menu.setAttribute("aria-label", "選択範囲の操作");
    this.createSelectionMenuButton(menu, "copy", "コピー", () => {
      ((...args: any[]) => (null as any))();
      ((...args: any[]) => (null as any))();
    });
    this.createSelectionMenuButton(menu, "clipboard-paste", "貼り付け", () => {
      ((...args: any[]) => (null as any))();
      ((...args: any[]) => (null as any))();
    }, () => this.strokeClipboard.length === 0);
    this.createSelectionMenuButton(menu, "trash-2", "削除", () => {
      ((...args: any[]) => (null as any))();
      ((...args: any[]) => (null as any))();
    }, () => this.selectedStrokeIds.size === 0, true);
  }

  private createCaptureMenu(menu: HTMLElement): void {
    menu.setAttribute("aria-label", "画像の操作");
    this.createSelectionMenuButton(menu, "copy", "画像をコピー", () => {
      void ((...args: any[]) => (null as any))();
    }, () => !this.captureRect);
    this.createSelectionMenuButton(menu, "image-down", "画像を別名で保存", () => {
      void ((...args: any[]) => (null as any))();
    }, () => !this.captureRect);
  }

  

  

  

  private createPdfMenuButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: (event: MouseEvent) => void,
    options: {
      disabled?: () => boolean;
      danger?: boolean;
      swatch?: string;
      chevron?: boolean;
      showText?: boolean;
    } = {}
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: `mobile-ink-pdf-menu-button${options.danger ? " mobile-ink-danger-option" : ""}`,
      attr: {
        type: "button",
        "aria-label": label,
        title: label
      }
    });
    setIcon(button, icon);
    if (options.showText !== false) {
      button.createSpan({ cls: "mobile-ink-pdf-menu-button-label", text: label });
    }
    if (options.swatch) {
      const swatch = button.createSpan({ cls: "mobile-ink-pdf-menu-swatch" });
      swatch.style.backgroundColor = options.swatch;
    }
    if (options.chevron) {
      const chevron = button.createSpan({ cls: "mobile-ink-pdf-menu-chevron" });
      setIcon(chevron, "chevron-down");
    }
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (options.disabled?.()) return;
      onClick(event);
    });
    return button;
  }

  private createPdfColorRow(parent: HTMLElement, kind: PdfTextAnnotationKind, onSelect: (color: string) => void): HTMLElement {
    const row = parent.createDiv({ cls: "mobile-ink-pdf-color-row" });
    row.dataset.kind = kind;

    for (const color of PDF_TEXT_ANNOTATION_COLORS) {
      const button = row.createEl("button", {
        cls: "mobile-ink-pdf-color-choice",
        attr: {
          type: "button",
          "aria-label": color,
          title: color
        }
      });
      button.style.backgroundColor = color;
      button.dataset.color = color;
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(color);
      });
    }

    const customButton = row.createEl("label", {
      cls: "mobile-ink-pdf-color-choice mobile-ink-pdf-color-custom",
      attr: { title: "好きな色を選ぶ" }
    });
    const input = customButton.createEl("input", {
      attr: {
        type: "color",
        value: this.pdfTextAnnotationColors[kind] ?? (kind === "underline" ? PDF_TEXT_UNDERLINE_COLOR : PDF_TEXT_HIGHLIGHT_COLOR)
      }
    });
    customButton.dataset.color = input.value;
    input.addEventListener("change", () => {
      customButton.dataset.color = input.value;
      onSelect(input.value);
    });
    const chevron = row.createSpan({ cls: "mobile-ink-pdf-color-chevron" });
    setIcon(chevron, "chevron-down");

    return row;
  }

  private createSelectionMenuButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    isDisabled?: () => boolean,
    danger = false
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: `mobile-ink-selection-menu-button${danger ? " mobile-ink-danger-option" : ""}`,
      attr: {
        type: "button",
        "aria-label": label,
        title: label
      }
    });
    setIcon(button, icon);
    button.createSpan({ text: label });
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDisabled?.()) return;
      onClick();
    });
    return button;
  }

  private createColorButton(parent: HTMLElement, label: string, color: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "mobile-ink-color-button",
      attr: {
        type: "button",
        "aria-label": label,
        title: label
      }
    });
    const dot = button.createSpan({ cls: "mobile-ink-color-dot" });
    dot.style.backgroundColor = color;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
      this.setPaletteOpen(false);
    });
    this.colorButtons.set(color.toLowerCase(), button);
    return button;
  }

  private bindToolbarDrag(target: HTMLElement): void {
    target.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!this.toolbarEl || !this.rootEl) return;

      event.preventDefault();
      event.stopPropagation();
      this.setPaletteOpen(false);
      this.setWidthPanelOpen(false);
      this.setEraserPanelOpen(false);
      this.setMorePanelOpen(false);

      const rootRect = this.rootEl.getBoundingClientRect();
      const toolbarRect = this.toolbarEl.getBoundingClientRect();
      const startLeft = toolbarRect.left - rootRect.left;
      const startTop = toolbarRect.top - rootRect.top;
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;

      this.toolbarEl.classList.add("mobile-ink-toolbar-dragging");
      this.toolbarPosition = { left: startLeft, top: startTop };
      this.applyToolbarPosition();

      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Some embedded browsers can throw if capture is unavailable.
      }

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;

        moveEvent.preventDefault();
        moveEvent.stopPropagation();
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          moved = true;
        }
        this.setToolbarPosition(startLeft + dx, startTop + dy, false);
      };

      const handleEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== event.pointerId) return;

        endEvent.preventDefault();
        endEvent.stopPropagation();
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleEnd);
        target.removeEventListener("pointercancel", handleEnd);
        this.toolbarEl?.classList.remove("mobile-ink-toolbar-dragging");
        if (moved) {
          this.persistToolbarPosition();
          this.suppressToolbarClick = true;
          window.setTimeout(() => {
            this.suppressToolbarClick = false;
          }, 0);
        }
        try {
          target.releasePointerCapture(event.pointerId);
        } catch {
          // Ignore capture release errors from browser-specific implementations.
        }
      };

      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleEnd);
      target.addEventListener("pointercancel", handleEnd);
    });
  }

  private setToolbarPosition(left: number, top: number, persist = true): void {
    if (!this.toolbarEl || !this.rootEl) return;

    const rootRect = this.rootEl.getBoundingClientRect();
    const toolbarRect = this.toolbarEl.getBoundingClientRect();
    const margin = 12;
    const maxLeft = Math.max(margin, rootRect.width - toolbarRect.width - margin);
    const maxTop = Math.max(margin, rootRect.height - toolbarRect.height - margin);

    this.toolbarPosition = {
      left: Math.min(Math.max(left, margin), maxLeft),
      top: Math.min(Math.max(top, margin), maxTop)
    };
    this.applyToolbarPosition();
    if (persist) {
      this.persistToolbarPosition();
    }
  }

  private applyToolbarPosition(): void {
    if (!this.toolbarEl || !this.toolbarPosition) return;

    this.toolbarEl.style.left = `${this.toolbarPosition.left}px`;
    this.toolbarEl.style.top = `${this.toolbarPosition.top}px`;
    this.toolbarEl.style.right = "auto";
    this.toolbarEl.style.bottom = "auto";
    this.toolbarEl.style.transform = "none";
    this.toolbarEl.classList.add("mobile-ink-toolbar-positioned");
    this.updatePopoverPlacement();
  }

  private getToolbarCenter(): { x: number; y: number } | null {
    if (!this.toolbarEl || !this.rootEl) return null;

    const rootRect = this.rootEl.getBoundingClientRect();
    const toolbarRect = this.toolbarEl.getBoundingClientRect();
    return {
      x: toolbarRect.left - rootRect.left + toolbarRect.width / 2,
      y: toolbarRect.top - rootRect.top + toolbarRect.height / 2
    };
  }

  private positionToolbarAroundCenter(center: { x: number; y: number }): void {
    requestAnimationFrame(() => {
      if (!this.toolbarEl) return;

      const toolbarRect = this.toolbarEl.getBoundingClientRect();
      this.setToolbarPosition(center.x - toolbarRect.width / 2, center.y - toolbarRect.height / 2);
    });
  }

  private restoreToolbarPosition(): void {
    if (this.toolbarPosition) return;

    try {
      const raw = localStorage.getItem(this.toolbarPositionStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
      if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return;
      if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return;
      this.toolbarPosition = { left: parsed.left, top: parsed.top };
    } catch {
      // Ignore malformed or unavailable storage.
    }
  }

  private persistToolbarPosition(): void {
    if (!this.toolbarPosition) return;

    try {
      localStorage.setItem(this.toolbarPositionStorageKey, JSON.stringify(this.toolbarPosition));
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }

  private updatePopoverPlacement(): void {
    if (!this.toolbarEl || !this.rootEl) return;

    const rootRect = this.rootEl.getBoundingClientRect();
    const toolbarRect = this.toolbarEl.getBoundingClientRect();
    const panel = this.morePanelOpen
      ? this.morePanelEl
      : this.eraserPanelOpen
        ? this.eraserPanelEl
        : this.widthPanelOpen
          ? this.widthPanelEl
          : this.paletteOpen
            ? this.colorPaletteEl
            : null;
    const panelHeight = panel?.offsetHeight || 170;
    const spaceAbove = toolbarRect.top - rootRect.top;
    const spaceBelow = rootRect.bottom - toolbarRect.bottom;
    const placeBelow = spaceAbove < panelHeight + 18 && spaceBelow > spaceAbove;

    this.toolbarEl.classList.toggle("mobile-ink-popover-below", placeBelow);
  }

  private installZoomHandlers(scroll: HTMLElement): void {
    scroll.addEventListener("wheel", this.onZoomWheel, { passive: false });
    scroll.addEventListener("touchstart", this.onZoomTouchStart, { passive: false });
    scroll.addEventListener("touchmove", this.onZoomTouchMove, { passive: false });
    scroll.addEventListener("touchend", this.onZoomTouchEnd, { passive: false });
    scroll.addEventListener("touchcancel", this.onZoomTouchEnd, { passive: false });
  }

  private installSelectionHandlers(selectionLayer: HTMLElement): void {
    selectionLayer.addEventListener("pointerdown", ((...args: any[]) => (null as any)));
    selectionLayer.addEventListener("pointermove", ((...args: any[]) => (null as any)));
    selectionLayer.addEventListener("pointerup", ((...args: any[]) => (null as any)));
    selectionLayer.addEventListener("pointercancel", ((...args: any[]) => (null as any)));
    selectionLayer.addEventListener("contextmenu", ((...args: any[]) => (null as any)));
    selectionLayer.addEventListener("touchstart", ((...args: any[]) => (null as any)), { passive: false });
    selectionLayer.addEventListener("touchmove", ((...args: any[]) => (null as any)), { passive: false });
    selectionLayer.addEventListener("touchend", ((...args: any[]) => (null as any)), { passive: false });
    selectionLayer.addEventListener("touchcancel", ((...args: any[]) => (null as any)), { passive: false });
  }

  private onZoomWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.target instanceof Element && (event.target as HTMLElement)?.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav")) return;

    event.preventDefault();
    event.stopPropagation();
    this.zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY);
  };

  private zoomBy(factor: number, clientX?: number, clientY?: number): void {
    this.setZoom(this.zoom * factor, clientX, clientY);
  }

  private onZoomTouchStart = (event: TouchEvent): void => {
    if (event.target instanceof Element && (event.target as HTMLElement)?.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-selection-menu, .modal-container")) return;
    if (this.getZoomTouches(event).length !== 2) return;

    const distance = this.getTouchDistance(this.getZoomTouches(event));
    if (distance <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    this.selectionDrag = null;
    this.markPdfInteractionBusy();
    this.selectionTouchId = null;
    ((...args: any[]) => (null as any))();
    ((...args: any[]) => (null as any))();
    ((...args: any[]) => (null as any))();
    this.pinchZoomState = {
      startDistance: distance,
      startZoom: this.zoom
    };
    this.engine?.setInputEnabled(false);
    this.enterInkInteractionMode();
  };

  private onZoomTouchMove = (event: TouchEvent): void => {
    if (!this.pinchZoomState) {
      if (this.getZoomTouches(event).length === 2) {
        this.onZoomTouchStart(event);
      }
      return;
    }
    if (this.getZoomTouches(event).length < 2) return;

    const distance = this.getTouchDistance(this.getZoomTouches(event));
    const center = this.getTouchCenter(this.getZoomTouches(event));
    if (distance <= 0 || !center) return;

    event.preventDefault();
    event.stopPropagation();
    this.markPdfInteractionBusy();
    this.setZoom(this.pinchZoomState.startZoom * (distance / this.pinchZoomState.startDistance), center.x, center.y);
  };

  private onZoomTouchEnd = (event: TouchEvent): void => {
    if (!this.pinchZoomState || this.getZoomTouches(event).length >= 2) return;

    event.preventDefault();
    event.stopPropagation();
    this.pinchZoomState = null;
    this.syncInkInputEnabled();
    this.scheduleInkSharpDisplayScaleUpdate();
    this.updateInkDisplayScaleNow();
    this.queueVisiblePdfPagesRender();
    this.scheduleSharpPdfBackgroundRender();
  };

  private getZoomTouches(event: TouchEvent): Touch[] {
    return Array.from(event.touches);
  }

  private getTouchDistance(touches: readonly Touch[]): number {
    const first = touches[0];
    const second = touches[1];
    if (!first || !second) return 0;

    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }

  private getTouchCenter(touches: readonly Touch[]): { x: number; y: number } | null {
    const first = touches[0];
    const second = touches[1];
    if (!first || !second) return null;

    return {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2
    };
  }

  private setZoom(nextZoom: number, clientX?: number, clientY?: number): void {
    const next = this.clampZoom(nextZoom);
    if (Math.abs(next - this.zoom) < 0.001) return;

    const scroll = this.scrollEl;
    if (!scroll) {
      this.zoom = next;
      this.applyZoom();
      this.scheduleInkDisplayScaleUpdate();
      this.markPdfInteractionBusy();
      this.refreshToolbarState();
      return;
    }

    const rect = scroll.getBoundingClientRect();
    const anchorX = clientX ?? rect.left + rect.width / 2;
    const anchorY = clientY ?? rect.top + rect.height / 2;
    const viewportX = anchorX - rect.left;
    const viewportY = anchorY - rect.top;
    const oldFrameLeft = this.pageFrameEl?.offsetLeft ?? 0;
    const oldFrameTop = this.pageFrameEl?.offsetTop ?? 0;
    const logicalX = (scroll.scrollLeft + viewportX - oldFrameLeft) / this.zoom;
    const logicalY = (scroll.scrollTop + viewportY - oldFrameTop) / this.zoom;

    this.zoom = next;
    this.applyZoom();
    this.scheduleInkDisplayScaleUpdate();
    this.markPdfInteractionBusy();

    const newFrameLeft = this.pageFrameEl?.offsetLeft ?? 0;
    const newFrameTop = this.pageFrameEl?.offsetTop ?? 0;
    scroll.scrollLeft = Math.max(0, newFrameLeft + logicalX * this.zoom - viewportX);
    scroll.scrollTop = Math.max(0, newFrameTop + logicalY * this.zoom - viewportY);
    this.refreshToolbarState();
    this.pdfPageNavigator.queueUpdate();
  }

  private getInkDisplayScale():number {return Math.max(1,Math.min(this.zoom,this.isMobileLike() ? 3 : INK_DESKTOP_MAX_DISPLAY_SCALE));}
  private enterInkInteractionMode():void {
    this.inkInteractionActive=true;
    this.saveQueue?.setPaused(true);
    this.markPdfInteractionBusy();
  }
  private scheduleInkSharpDisplayScaleUpdate():void {
    this.inkInteractionActive=false;
    this.saveQueue?.setPaused(false);
    this.markPdfInteractionBusy();
  }

  private scheduleInkDisplayScaleUpdate(): void {
    if (this.pinchZoomState !== null || this.inkScaleRaf !== null) return;

    this.inkScaleRaf = requestAnimationFrame(() => {
      this.inkScaleRaf = null;
      if (this.pinchZoomState !== null) return;
      this.updateInkDisplayScaleNow();
    });
  }

  private updateInkDisplayScaleNow(): void {
    if (this.inkScaleRaf !== null) {
      cancelAnimationFrame(this.inkScaleRaf);
      this.inkScaleRaf = null;
    }

    this.engine?.setDisplayScale(this.getInkDisplayScale());
  }

  private cancelInkDisplayScaleUpdate(): void {
    if (this.inkSharpTimer !== null) {
      window.clearTimeout(this.inkSharpTimer);
      this.inkSharpTimer = null;
    }
    this.inkInteractionActive = false;
    if (this.inkScaleRaf === null) return;

    cancelAnimationFrame(this.inkScaleRaf);
    this.inkScaleRaf = null;
  }

  private clampZoom(value: number): number {
    return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
  }

  private applyZoom(): void {
    if (!this.pageEl || !this.pageFrameEl) return;

    const width = Math.max(1, this.pageLogicalWidth);
    const height = Math.max(1, this.pageLogicalHeight);
    this.pageFrameEl.style.width = `${width * this.zoom}px`;
    this.pageFrameEl.style.height = `${height * this.zoom}px`;

    if (this.standalone && this.standaloneContentEl) {
      // Multi-page standalone: scale the inner content wrapper (contains page cards + tiles)
      this.standaloneContentEl.style.width = `${width}px`;
      this.standaloneContentEl.style.height = `${height}px`;
      this.standaloneContentEl.style.transform = `scale(${this.zoom})`;
    } else {
      // Single-page or PDF/Markdown annotation mode
      this.pageEl.style.width = `${width}px`;
      this.pageEl.style.height = `${height}px`;
      this.pageEl.style.transform = `scale(${this.zoom})`;
    }
  }

  private getVisibleLogicalYRange(): { top: number; bottom: number } {
    const scroll = this.scrollEl;
    if (!scroll) {
      return { top: 0, bottom: this.pageLogicalHeight };
    }

    const frameTop = this.pageFrameEl?.offsetTop ?? 0;
    const zoom = Math.max(0.001, this.zoom);
    const top = Math.max(0, (scroll.scrollTop - frameTop) / zoom);
    const bottom = Math.min(this.pageLogicalHeight, (scroll.scrollTop + scroll.clientHeight - frameTop) / zoom);
    return { top, bottom: Math.max(top, bottom) };
  }

  

  

  

  

  

  

  

  private showSelectionMenuAt(point: PagePoint): void {
    if (!this.selectionMenuEl || this.selectedStrokeIds.size === 0) return;

    ((...args: any[]) => (null as any))();
    this.selectionMenuEl.style.display = "flex";
    this.selectionMenuEl.style.left = `${point.x}px`;
    this.selectionMenuEl.style.top = `${point.y}px`;

    requestAnimationFrame(() => {
      if (!this.selectionMenuEl) return;

      const menuWidth = this.selectionMenuEl.offsetWidth || 168;
      const menuHeight = this.selectionMenuEl.offsetHeight || 44;
      const left = Math.min(Math.max(point.x, 6), Math.max(6, this.pageLogicalWidth - menuWidth - 6));
      const top = Math.min(Math.max(point.y, 6), Math.max(6, this.pageLogicalHeight - menuHeight - 6));
      this.selectionMenuEl.style.left = `${left}px`;
      this.selectionMenuEl.style.top = `${top}px`;
    });
  }

  

  

  

  

  private eventToPagePoint(event: PointerEvent): PagePoint | null {
    const page = this.getPageCoordinateElement();
    if (!page) return null;

    const rect = page.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    return {
      x: Math.min(Math.max((event.clientX - rect.left) * (this.pageLogicalWidth / rect.width), 0), this.pageLogicalWidth),
      y: Math.min(Math.max((event.clientY - rect.top) * (this.pageLogicalHeight / rect.height), 0), this.pageLogicalHeight)
    };
  }

  private mouseEventToPagePoint(event: MouseEvent): PagePoint | null {
    const page = this.getPageCoordinateElement();
    if (!page) return null;

    const rect = page.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    return {
      x: Math.min(Math.max((event.clientX - rect.left) * (this.pageLogicalWidth / rect.width), 0), this.pageLogicalWidth),
      y: Math.min(Math.max((event.clientY - rect.top) * (this.pageLogicalHeight / rect.height), 0), this.pageLogicalHeight)
    };
  }

  private touchToPagePoint(touch: Touch): PagePoint | null {
    const page = this.getPageCoordinateElement();
    if (!page) return null;

    const rect = page.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    return {
      x: Math.min(Math.max((touch.clientX - rect.left) * (this.pageLogicalWidth / rect.width), 0), this.pageLogicalWidth),
      y: Math.min(Math.max((touch.clientY - rect.top) * (this.pageLogicalHeight / rect.height), 0), this.pageLogicalHeight)
    };
  }

  private getPageCoordinateElement(): HTMLElement | null {
    return this.standalone && this.standaloneContentEl ? this.standaloneContentEl : this.pageEl;
  }

  private findChangedTouch(event: TouchEvent, identifier: number): Touch | null {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches.item(i);
      if (touch?.identifier === identifier) return touch;
    }

    return null;
  }

  private normalizeRect(start: PagePoint, end: PagePoint): PageRect {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    return {
      x,
      y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  }

  private inflateRect(rect: PageRect, amount: number): PageRect {
    return {
      x: rect.x - amount,
      y: rect.y - amount,
      width: rect.width + amount * 2,
      height: rect.height + amount * 2
    };
  }

  

  

  

  

  private setPageRect(element: HTMLElement, rect: PageRect): void {
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${Math.max(0, rect.width)}px`;
    element.style.height = `${Math.max(0, rect.height)}px`;
  }

  private findStrokeIdsInRect(rect: PageRect): Set<string> {
    const result = new Set<string>();
    for (const stroke of this.engine?.getStrokes() ?? []) {
      const bounds = this.getStrokeBounds(stroke);
      if (bounds && this.rectsIntersect(bounds, rect)) {
        result.add(stroke.id);
      }
    }
    return result;
  }

  private getSelectedStrokeBounds(): PageRect | null {
    if (this.selectedStrokeIds.size === 0) return null;

    let result: PageRect | null = null;
    for (const stroke of this.engine?.getStrokes() ?? []) {
      if (!this.selectedStrokeIds.has(stroke.id)) continue;

      const bounds = this.getStrokeBounds(stroke);
      if (!bounds) continue;
      result = result ? this.unionRects(result, bounds) : bounds;
    }
    return result;
  }

  private getStrokesBounds(strokes: InkStroke[]): PageRect | null {
    let result: PageRect | null = null;
    for (const stroke of strokes) {
      const bounds = this.getStrokeBounds(stroke);
      if (!bounds) continue;
      result = result ? this.unionRects(result, bounds) : bounds;
    }
    return result;
  }

  private getStrokeBounds(stroke: InkStroke): PageRect | null {
    if (stroke.points.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const padding = Math.max(2, stroke.width / 2);
    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2
    };
  }

  private rectsIntersect(a: PageRect, b: PageRect): boolean {
    return a.x <= b.x + b.width
      && a.x + a.width >= b.x
      && a.y <= b.y + b.height
      && a.y + a.height >= b.y;
  }

  private pointInRect(point: PagePoint, rect: PageRect): boolean {
    return point.x >= rect.x
      && point.x <= rect.x + rect.width
      && point.y >= rect.y
      && point.y <= rect.y + rect.height;
  }

  private unionRects(a: PageRect, b: PageRect): PageRect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: right - x, height: bottom - y };
  }

  private translateStroke(stroke: InkStroke, dx: number, dy: number): InkStroke {
    return {
      ...stroke,
      points: stroke.points.map((point: any) => ({
        ...point,
        x: point.x + dx,
        y: point.y + dy
      }))
    };
  }

  private cloneStroke(stroke: InkStroke): InkStroke {
    return {
      ...stroke,
      points: stroke.points.map((point: any) => ({ ...point }))
    };
  }

  private duplicateStroke(stroke: InkStroke, dx: number, dy: number): InkStroke {
    return {
      ...this.translateStroke(stroke, dx, dy),
      id: crypto.randomUUID()
    };
  }

  private installInputGuards(root: HTMLElement): void {
    const blockDefault = (event: Event) => {
      if (this.selectMode && this.shouldBlockNativeTextCallout(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.selectMode) return;
      if (event.target instanceof Element && (event.target as HTMLElement)?.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-object-layer")) return;
      if (this.isSelectionContextMenuEvent(event) || this.isCaptureContextMenuEvent(event)) return;

      event.preventDefault();
      event.stopPropagation();
    };
    const markInputBusy = (event: PointerEvent) => {
      if (event.target instanceof Element && (event.target as HTMLElement)?.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-object-layer")) return;
      if (event.pointerType === "pen" || event.pointerType === "touch" || event.buttons !== 0) {
        this.pdfInteractionBusyUntil = performance.now() + PDF_BACKGROUND_SHARP_IDLE_MS;
      }
    };

    root.addEventListener("selectstart", blockDefault, { capture: true });
    root.addEventListener("dragstart", blockDefault, { capture: true });
    root.addEventListener("contextmenu", blockDefault, { capture: true });
    root.addEventListener("gesturestart", blockDefault, { capture: true });
    root.addEventListener("gesturechange", blockDefault, { capture: true });
    root.addEventListener("gestureend", blockDefault, { capture: true });
    root.addEventListener("pointerdown", this.onTextSelectionStart, { capture: true });
    root.addEventListener("touchstart", this.onTextSelectionStart, { capture: true, passive: true });
    root.addEventListener("pointerdown", this.onRootPointerDown, { capture: true });
    root.addEventListener("pointerdown", markInputBusy, { capture: true });
    root.addEventListener("pointerdown", this.onPdfBlankPointerDown, { capture: true });
    root.addEventListener("pointerdown", this.onPdfTextPointerDown, { capture: true });
    root.addEventListener("pointermove", markInputBusy, { capture: true });
    root.addEventListener("pointermove", this.onPdfTextLayerPointerMove, { capture: true });
    root.addEventListener("pointerup", markInputBusy, { capture: true });
    root.addEventListener("pointerup", this.onPdfTextLayerPointerUp, { capture: true });
    root.addEventListener("pointercancel", this.onPdfTextLayerPointerCancel, { capture: true });
    root.addEventListener("pointerup", this.onPdfTextSelectionFinished, { capture: true });
    root.addEventListener("touchstart", this.onPdfTextTouchStart, { capture: true, passive: false });
    root.addEventListener("touchmove", this.onPdfTextTouchMove, { capture: true, passive: false });
    root.addEventListener("touchend", this.onPdfTextTouchEnd, { capture: true, passive: false });
    root.addEventListener("touchcancel", this.onPdfTextTouchCancel, { capture: true, passive: false });
    root.addEventListener("keyup", this.onPdfTextSelectionFinished);
    root.addEventListener("keydown", this.onRootKeyDown);
  }

  private onTextSelectionStart = (event: Event): void => {
    if (!this.selectMode || this.standalone) return;
    if (!(event.target instanceof Element)) return;

    const target = event.target;
    if (target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-selection-menu, .mobile-ink-pdf-text-menu, .mobile-ink-pdf-annotation-menu, .modal-container")) return;
    if (target.closest(".mobile-ink-pdf-text-annotation, .mobile-ink-pdf-text-note-marker, .mobile-ink-markdown-text-annotation-layer")) return;
    if (!target.closest(".mobile-ink-background, .mobile-ink-pdf-text-layer")) return;
    if (this.pdfTextDragSelection || this.pdfPendingTextSelection) return;

    this.cancelPdfTextSelectionRefresh();
    this.pdfTextSelection = null;
    this.pdfTextSelectionIsCustom = false;
    this.pdfTextDragSelection = null;
    this.pdfPendingTextSelection = null;
    this.activePdfTextTouchId = null;
    this.clearPdfTextDragHighlights();
    this.hidePdfTextMenu();
    this.hidePdfAnnotationMenu();
    document.getSelection()?.removeAllRanges();
  };

  private shouldBlockNativeTextCallout(event: Event): boolean {
    if (event.type !== "contextmenu") return false;
    if (!(event.target instanceof Element)) return false;

    const target = event.target;
    if (target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-selection-menu, .mobile-ink-pdf-text-menu, .mobile-ink-pdf-annotation-menu, .modal-container")) {
      return false;
    }
    if (target.closest(".mobile-ink-pdf-text-annotation, .mobile-ink-pdf-text-note-marker, .mobile-ink-selection-layer")) {
      return false;
    }

    return !!target.closest(".mobile-ink-background, .mobile-ink-pdf-text-layer, .mobile-ink-pdf-page-background");
  }

  private onRootPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Element && (event.target as HTMLElement)?.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav")) return;
    if (this.standalone && this.selectedStandaloneElementId && event.target instanceof Element && !(event.target as HTMLElement)?.closest(".mobile-ink-object")) {
      ((...args: any[]) => (null as any))();
    }
    if (!this.hasOpenToolbarPopover()) return;

    this.closeToolbarPopovers();
  };

  private onAnnotationScroll = (): void => {
    if (this.pdfTextDragSelection || this.pdfPendingTextSelection || this.activePdfTextTouchId !== null) return;

    this.hidePdfTextMenu();
    this.hidePdfAnnotationMenu();
  };

  private onPdfBlankPointerDown = (event: PointerEvent): void => {
    if (this.standalone) return;
    if (!(event.target instanceof Element)) return;

    const target = event.target;
    if (target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-pdf-text-menu, .mobile-ink-pdf-annotation-menu, .modal-container")) return;
    if (target.closest(".mobile-ink-pdf-text-layer span, .mobile-ink-pdf-text-annotation, .mobile-ink-pdf-text-note-marker, .mobile-ink-background")) return;

    this.pdfPageNavigator.setExpanded(false);
    this.clearPdfTextSelectionUi();
  };

  private isSelectionContextMenuEvent(event: Event): boolean {
    if (event.type !== "contextmenu") return false;
    if (!this.strokeSelectMode || this.selectedStrokeIds.size === 0) return false;
    if (!(event instanceof MouseEvent)) return false;
    if (!(event.target instanceof Element) || !(event.target as HTMLElement)?.closest(".mobile-ink-selection-layer")) return false;

    const point = this.mouseEventToPagePoint(event);
    const selectedBounds = this.getSelectedStrokeBounds();
    return !!point && !!selectedBounds && this.pointInRect(point, this.inflateRect(selectedBounds, 6));
  }

  private isCaptureContextMenuEvent(event: Event): boolean {
    if (event.type !== "contextmenu") return false;
    if (!this.captureMode || !this.captureRect) return false;
    if (!(event instanceof MouseEvent)) return false;
    if (!(event.target instanceof Element) || !(event.target as HTMLElement)?.closest(".mobile-ink-selection-layer")) return false;

    const point = this.mouseEventToPagePoint(event);
    return !!point && this.pointInRect(point, this.inflateRect(this.captureRect, 4));
  }

  private onRootKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (this.isShortcutEditableTarget(event.target)) return;

    if (this.captureMode && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ((...args: any[]) => (null as any))();
      return;
    }

    if (this.selectedStandaloneElementId && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ((...args: any[]) => (null as any))();
      return;
    }

    if (this.strokeSelectMode && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ((...args: any[]) => (null as any))();
      return;
    }

    if (event.key === "Escape" && (this.pdfTextSelection || this.activePdfTextAnnotationId || this.hasOpenToolbarPopover())) {
      event.preventDefault();
      event.stopPropagation();
      this.clearPdfTextSelectionUi();
      this.closeToolbarPopovers();
      return;
    }

    const shortcut = event.ctrlKey || event.metaKey;
    if (!shortcut) {
      if ((event.key === "Delete" || event.key === "Backspace") && this.selectedStandaloneElementId) {
        event.preventDefault();
        event.stopPropagation();
        this.deleteStandaloneElement(this.selectedStandaloneElementId);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && this.strokeSelectMode && this.selectedStrokeIds.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        ((...args: any[]) => (null as any))();
      }
      return;
    }

    const key = event.key.toLowerCase();

    if (key === "s") {
      event.preventDefault();
      event.stopPropagation();
      void this.saveCurrentAnnotation().catch(error => console.error("Note Ink: save failed", error));
      return;
    }

    if (key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        this.redoCurrentAnnotation();
      } else {
        this.undoCurrentAnnotation();
      }
      return;
    }

    if (key === "y") {
      event.preventDefault();
      event.stopPropagation();
      this.redoCurrentAnnotation();
      return;
    }

    if (shortcut && event.key.toLowerCase() === "c") {
      if (this.pdfTextSelection?.text && this.pdfTextSelection.visualOnly !== true) {
        event.preventDefault();
        event.stopPropagation();
        void this.copyPdfSelectedText();
        return;
      }
      if (this.captureMode && this.captureRect) {
        event.preventDefault();
        event.stopPropagation();
        void ((...args: any[]) => (null as any))();
        return;
      }
      if (!this.strokeSelectMode || this.selectedStrokeIds.size === 0) return;

      event.preventDefault();
      event.stopPropagation();
      ((...args: any[]) => (null as any))();
      return;
    }

    if (shortcut && event.key.toLowerCase() === "v") {
      if (this.strokeClipboard.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      ((...args: any[]) => (null as any))();
      return;
    }
  };

  private onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.shouldHandleDocumentShortcut(event)) return;
    this.onRootKeyDown(event);
  };

  private shouldHandleDocumentShortcut(event: KeyboardEvent): boolean {
    if (!this.rootEl) return false;
    if (this.isShortcutEditableTarget(event.target)) return false;

    const target = event.target;
    if (target instanceof Node && this.rootEl.contains(target)) return true;

    return this.app.workspace.getActiveViewOfType(AnnotationView) === this;
  }

  private isShortcutEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    if (target instanceof HTMLElement && target.isContentEditable) return true;

    return !!target.closest("input, textarea, select, [contenteditable='true'], .cm-editor, .modal-container");
  }

  private undoCurrentAnnotation(): void {
    if (!this.engine) return;

    ((...args: any[]) => (null as any))();
    this.engine.undo();
    this.refreshToolbarState();
  }

  private redoCurrentAnnotation(): void {
    if (!this.engine) return;

    ((...args: any[]) => (null as any))();
    this.engine.redo();
    this.refreshToolbarState();
  }

  private async setupMarkdownPage(file: TFile, scroll: HTMLElement, page: HTMLElement, background: HTMLElement): Promise<{ width: number; height: number }> {
    const defaultPageSize = this.getDefaultMarkdownPageSize(scroll);
    const loadedAnnotation = await this.plugin.store.load(file.path, defaultPageSize.width, defaultPageSize.height);
    this.savedMarkdownLayout = loadedAnnotation.markdownLayout ?? null;
    assertDimensions(loadedAnnotation.pageWidth, loadedAnnotation.pageHeight);
    const hasSavedStrokes = loadedAnnotation.strokes.length > 0;
    const savedWidth = Number.isFinite(loadedAnnotation.pageWidth) && loadedAnnotation.pageWidth > 0
      ? Math.ceil(loadedAnnotation.pageWidth)
      : 0;
    const savedHeight = Number.isFinite(loadedAnnotation.pageHeight) && loadedAnnotation.pageHeight > 0
      ? Math.ceil(loadedAnnotation.pageHeight)
      : 0;
    const preferredWidth = hasSavedStrokes && savedWidth > 0
      ? savedWidth
      : defaultPageSize.width;
    const preferredHeight = hasSavedStrokes && savedHeight > 0
      ? savedHeight
      : undefined;

    page.style.width = `${preferredWidth}px`;
    background.style.width = `${preferredWidth}px`;
    await this.renderMarkdownBackground(file, background);
    this.savedMarkdownLayout = this.isSavedMarkdownLayoutCompatible(loadedAnnotation, file)
      ? this.savedMarkdownLayout
      : null;
    const pageSize = await this.measureAndFreezePage(scroll, page, background, preferredWidth, preferredHeight);
    assertDimensions(pageSize.width, pageSize.height);
    this.currentMarkdownLayout = this.collectMarkdownLayoutSnapshot() ?? null;
    this.annotation = loadedAnnotation;
    this.pdfTextAnnotations = this.prepareMarkdownTextAnnotationsForCurrentLayout(
      loadedAnnotation.pdfTextAnnotations ?? [],
      loadedAnnotation.pageWidth,
      loadedAnnotation.pageHeight
    );
    this.renderPdfTextAnnotations();
    return pageSize;
  }

  private async setupPdfPage(file: TFile, scroll: HTMLElement, page: HTMLElement, background: HTMLElement): Promise<{ width: number; height: number }> {
    background.empty();
    background.removeClass("markdown-preview-view");
    background.addClass("mobile-ink-pdf-background");

    const token = ++this.pdfRenderToken;
    const pageSize = await this.renderPdfBackground(file, scroll, background, token);
    this.freezePageSize(page, background, pageSize.width, pageSize.height);
    this.annotation = await this.plugin.store.load(file.path, pageSize.width, pageSize.height);
    this.pdfTextAnnotations = this.preparePdfTextAnnotationsForCurrentLayout(this.annotation.pdfTextAnnotations ?? [], this.annotation.pageWidth);
    this.renderPdfTextAnnotations();
    this.attachPdfLazyRenderer(scroll);
    this.queueVisiblePdfPagesRender();
    return pageSize;
  }

  

  private attachSelectionLayerToStandaloneContent(contentEl: HTMLElement): void {
    const selectionLayer = this.selectionLayerEl;
    if (!selectionLayer) return;

    contentEl.appendChild(selectionLayer);
  }

  private addStandalonePageEl(
    pageFrame: HTMLElement,
    pageWidth: number,
    pageHeight: number,
    template: string,
    pageNumber: number,
    pageGap: number
  ): HTMLElement {
    const pageTop = (pageNumber - 1) * (pageHeight + pageGap);
    const pageEl = pageFrame.createDiv({ cls: "mobile-ink-standalone-page" });
    pageEl.dataset.pageNumber = String(pageNumber);
    pageEl.style.position = "absolute";
    pageEl.style.left = "0px";
    pageEl.style.top = `${pageTop}px`;
    pageEl.style.width = `${pageWidth}px`;
    pageEl.style.height = `${pageHeight}px`;

    const bg = pageEl.createDiv({ cls: "mobile-ink-standalone-background mobile-ink-background markdown-preview-view" });
    bg.style.width = `${pageWidth}px`;
    bg.style.height = `${pageHeight}px`;
    bg.setAttribute("data-template", template);

    const objectLayer = pageEl.createDiv({ cls: "mobile-ink-object-layer", attr: { "aria-hidden": "false" } });
    objectLayer.style.width = `${pageWidth}px`;
    objectLayer.style.height = `${pageHeight}px`;
    this.standaloneObjectLayerEls.set(pageNumber, objectLayer);

    this.standalonePageEls.push(pageEl);
    return pageEl;
  }

  private renderAddPageButton(pageFrame: HTMLElement, pageWidth: number, pageHeight: number, template: string, pageGap: number): void {
    // Remove existing add-page button if any
    pageFrame.querySelectorAll(".mobile-ink-add-page-btn").forEach(el => el.remove());

    const pageCount = this.standalonePageCount;
    const btnTop = pageCount * (pageHeight + pageGap);

    const btn = pageFrame.createEl("button", {
      cls: "mobile-ink-add-page-btn",
      attr: { type: "button", title: "新しいページを追加", "aria-label": "新しいページを追加" }
    });
    btn.style.top = `${btnTop + 8}px`;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>ページを追加</span>`;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await ((...args: any[]) => (null as any))(pageFrame, pageWidth, pageHeight, template, pageGap);
    });
  }

  

  private renderStandaloneShapeElement(objectEl: HTMLElement, element: Extract<StandaloneElement, { type: "shape" }>): void {
    const strokeWidth = Math.max(0, element.strokeWidth ?? 2);
    const stroke = element.stroke ?? "#8fb36d";
    const fill = element.fill ?? "rgba(255,255,255,0.72)";
    objectEl.style.opacity = String(element.opacity ?? 1);

    if (element.shape === "line") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("mobile-ink-shape-svg");
      svg.setAttribute("viewBox", `0 0 ${Math.max(1, element.width)} ${Math.max(1, element.height)}`);
      svg.setAttribute("preserveAspectRatio", "none");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(strokeWidth / 2));
      line.setAttribute("y1", String(strokeWidth / 2));
      line.setAttribute("x2", String(Math.max(strokeWidth / 2, element.width - strokeWidth / 2)));
      line.setAttribute("y2", String(Math.max(strokeWidth / 2, element.height - strokeWidth / 2)));
      line.setAttribute("stroke", stroke);
      line.setAttribute("stroke-width", String(strokeWidth));
      line.setAttribute("stroke-linecap", "round");
      svg.appendChild(line);
      objectEl.appendChild(svg);
      return;
    }

    const body = objectEl.createDiv({ cls: `mobile-ink-shape-body mobile-ink-shape-${element.shape}` });
    body.style.background = fill;
    body.style.border = strokeWidth > 0 ? `${strokeWidth}px solid ${stroke}` : "none";
    body.style.borderRadius = element.shape === "ellipse"
      ? "50%"
      : `${Math.max(0, element.borderRadius ?? (element.shape === "note" ? 8 : 4))}px`;
  }

  private renderStandaloneStickerElement(objectEl: HTMLElement, element: Extract<StandaloneElement, { type: "sticker" }>): void {
    objectEl.style.opacity = String(element.opacity ?? 1);
    objectEl.classList.add(`mobile-ink-sticker-${element.sticker}`);

    if (element.sticker.startsWith("tape-") || element.sticker === "sticky-note" || element.sticker.startsWith("label-")) {
      const body = objectEl.createDiv({ cls: "mobile-ink-sticker-body" });
      if (element.sticker === "sticky-note") {
        body.createDiv({ cls: "mobile-ink-sticker-note-pin" });
        body.createDiv({ cls: "mobile-ink-sticker-note-lines" });
      } else if (element.sticker === "label-memo") {
        body.createDiv({ cls: "mobile-ink-label-title", text: "MEMO" });
        body.createDiv({ cls: "mobile-ink-label-content" });
      } else if (element.sticker === "label-todo") {
        body.createDiv({ cls: "mobile-ink-label-title", text: "TO DO LIST" });
        const list = body.createDiv({ cls: "mobile-ink-label-list" });
        for (let i = 0; i < 4; i++) {
          const row = list.createDiv({ cls: "mobile-ink-label-list-row" });
          row.createDiv({ cls: "mobile-ink-label-checkbox" });
          row.createDiv({ cls: "mobile-ink-label-line" });
        }
      } else if (element.sticker === "label-heart") {
        body.createDiv({ cls: "mobile-ink-label-text", text: "今日の予定" });
        body.createDiv({ cls: "mobile-ink-label-icon", text: "💖" });
      }
      return;
    }

    const emojiText = ((...args: any[]) => (null as any))(element.sticker);
    if (emojiText) {
      objectEl.createDiv({ cls: "mobile-ink-sticker-emoji", text: element.text || emojiText });
      return;
    }

    this.renderStandaloneStickerSvg(objectEl, element.sticker);
  }

  

  private renderStandaloneStickerSvg(parent: HTMLElement, sticker: StandaloneStickerKind): void {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("mobile-ink-sticker-svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const add = (tag: string, attrs: Record<string, string>): SVGElement => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      svg.appendChild(el);
      return el;
    };

    if (sticker === "flower") {
      for (const [cx, cy] of [[50, 24], [72, 44], [64, 72], [36, 72], [28, 44]]) {
        add("ellipse", { cx: String(cx), cy: String(cy), rx: "18", ry: "24", fill: "#f7fbef", stroke: "#d7c98f", "stroke-width": "3" });
      }
      add("circle", { cx: "50", cy: "52", r: "14", fill: "#f5cf58", stroke: "#d2a63d", "stroke-width": "3" });
      add("path", { d: "M58 76 C72 76 82 67 88 55", fill: "none", stroke: "#8fb36d", "stroke-width": "5", "stroke-linecap": "round" });
      add("ellipse", { cx: "77", cy: "66", rx: "9", ry: "15", fill: "#a8c978", transform: "rotate(45 77 66)" });
    } else if (sticker === "paperclip") {
      add("path", { d: "M35 72 V28 C35 15 45 8 57 8 C70 8 78 18 78 31 V75 C78 91 66 98 51 98 C35 98 22 88 22 72 V27", fill: "none", stroke: "#77a9c4", "stroke-width": "8", "stroke-linecap": "round" });
      add("path", { d: "M50 72 V30 C50 24 54 21 59 21 C65 21 68 25 68 31 V73 C68 82 61 87 52 87 C43 87 35 81 35 72", fill: "none", stroke: "#cfe4ee", "stroke-width": "4", "stroke-linecap": "round" });
    } else if (sticker === "icon-heart") {
      add("path", { d: "M50 84 C21 61 12 45 18 29 C24 12 43 15 50 30 C57 15 76 12 82 29 C88 45 79 61 50 84 Z", fill: "#f08aa5", stroke: "#d46586", "stroke-width": "4", "stroke-linejoin": "round" });
    } else {
      add("path", { d: "M50 10 L61 36 L89 38 L68 56 L75 84 L50 69 L25 84 L32 56 L11 38 L39 36 Z", fill: "#f6cf59", stroke: "#d2a63d", "stroke-width": "4", "stroke-linejoin": "round" });
    }

    parent.appendChild(svg);
  }

  

  

  private toggleStickerPanel(event?: MouseEvent | TouchEvent): void {
    if (!this.standalone || !this.annotation) {
      new Notice("ステッカーを追加できるのは手書きノートのみです。");
      return;
    }
    this.setMorePanelOpen(false);
    if (this.stickerPanelOpen) {
      this.setStickerPanelOpen(false);
      return;
    }

    // Lazily build the sticker panel
    if (!this.stickerPanelEl) {
      this.buildStickerPanel();
    } else {
      // Rebuild to refresh custom assets asynchronously
      this.buildStickerPanel();
    }
    this.setStickerPanelOpen(true);
  }

  private setStickerPanelOpen(open: boolean): void {
    this.stickerPanelOpen = open;
    this.stickerPanelEl?.classList.toggle("mobile-ink-sticker-panel-open", open);
  }

  private buildStickerPanel(): void {
    // Remove old panel
    this.stickerPanelEl?.remove();
    this.stickerPanelEl = null;

    // Parent is the toolbar container so it appears near it
    const toolbar = this.toolbarEl;
    if (!toolbar) return;
    const parent = toolbar.parentElement ?? toolbar;

    const panel = parent.createDiv({ cls: "mobile-ink-sticker-panel" });
    this.stickerPanelEl = panel;

    // Close button
    const header = panel.createDiv({ cls: "mobile-ink-sticker-panel-header" });
    header.createSpan({ cls: "mobile-ink-sticker-panel-title", text: "ステッカー" });
    const closeBtn = header.createEl("button", { cls: "mobile-ink-sticker-panel-close", attr: { type: "button", "aria-label": "閉じる" } });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.setStickerPanelOpen(false));

    const scroll = panel.createDiv({ cls: "mobile-ink-sticker-panel-scroll" });

    const groups = this.getStandaloneStickerGroupedOptions();
    for (const group of groups) {
      scroll.createDiv({ cls: "mobile-ink-sticker-group-title", text: group.title });
      const grid = scroll.createDiv({ cls: "mobile-ink-sticker-grid" });
      for (const sticker of group.items) {
        const cell = grid.createEl("button", {
          cls: "mobile-ink-sticker-cell",
          attr: { type: "button", title: sticker.label, "aria-label": sticker.label }
        });
        const preview = cell.createDiv({ cls: "mobile-ink-sticker-cell-preview" });
        // Use the actual sticker rendering for preview
        this.renderStickerPreview(preview, sticker.kind);
        cell.createDiv({ cls: "mobile-ink-sticker-cell-label", text: sticker.label });
        cell.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          ((...args: any[]) => (null as any))(sticker.kind);
          this.setStickerPanelOpen(false);
        });
      }
    }

    // Async custom assets section
    void this.getStandaloneCustomStickerAssets().then((customAssets) => {
      if (!this.stickerPanelEl || !this.stickerPanelEl.isConnected) return;
      if (customAssets.length === 0) return;
      scroll.createDiv({ cls: "mobile-ink-sticker-group-title", text: "カスタム" });
      const grid = scroll.createDiv({ cls: "mobile-ink-sticker-grid" });
      for (const asset of customAssets) {
        const file = this.app.vault.getAbstractFileByPath(asset.path);
        if (!(file instanceof TFile)) continue;
        const cell = grid.createEl("button", {
          cls: "mobile-ink-sticker-cell",
          attr: { type: "button", title: asset.label, "aria-label": asset.label }
        });
        const preview = cell.createDiv({ cls: "mobile-ink-sticker-cell-preview" });
        const img = preview.createEl("img", { attr: { draggable: "false", alt: asset.label } });
        img.src = this.app.vault.getResourcePath(file);
        img.style.cssText = "width:100%;height:100%;object-fit:contain;pointer-events:none;";
        cell.createDiv({ cls: "mobile-ink-sticker-cell-label", text: asset.label });
        cell.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void ((...args: any[]) => (null as any))(asset);
          this.setStickerPanelOpen(false);
        });
      }
    });

    // Click outside to close
    const dismiss = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node) && e.target !== this.toolbarButtons.insertSticker) {
        this.setStickerPanelOpen(false);
        document.removeEventListener("mousedown", dismiss, true);
      }
    };
    document.addEventListener("mousedown", dismiss, true);
  }

  private renderStickerPreview(parent: HTMLElement, kind: StandaloneStickerKind): void {
    const emojiText = ((...args: any[]) => (null as any))(kind);
    if (emojiText) {
      parent.createDiv({ cls: "mobile-ink-sticker-cell-emoji", text: emojiText });
      return;
    }
    if (kind === "flower" || kind === "paperclip" || kind.startsWith("icon-")) {
      const fakeEl = parent.createDiv();
      fakeEl.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;";
      this.renderStandaloneStickerSvg(fakeEl, kind);
      return;
    }
    // For tape and labels, render a mini div with the CSS class
    const fakeOuter = parent.createDiv({ cls: `mobile-ink-sticker-object mobile-ink-sticker-${kind}` });
    fakeOuter.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;border-radius:4px;";
    const body = fakeOuter.createDiv({ cls: "mobile-ink-sticker-body" });
    if (kind === "sticky-note") {
      body.createDiv({ cls: "mobile-ink-sticker-note-pin" });
      body.createDiv({ cls: "mobile-ink-sticker-note-lines" });
    } else if (kind === "label-memo") {
      body.createDiv({ cls: "mobile-ink-label-title", text: "MEMO" });
      body.createDiv({ cls: "mobile-ink-label-content" });
    } else if (kind === "label-todo") {
      body.createDiv({ cls: "mobile-ink-label-title", text: "TODO" });
    } else if (kind === "label-heart") {
      body.createDiv({ cls: "mobile-ink-label-text", text: "今日" });
    }
  }

  /** @deprecated use toggleStickerPanel */
  

  private getStandaloneStickerGroupedOptions(): Array<{ title: string; items: Array<{ kind: StandaloneStickerKind; label: string; icon: string }> }> {
    return [
      {
        title: "🎯 テープとラベル",
        items: [
          { kind: "tape-blue", label: "青いテープ", icon: "minus" },
          { kind: "tape-green", label: "緑のテープ", icon: "minus" },
          { kind: "tape-yellow", label: "黄いテープ", icon: "minus" },
          { kind: "tape-pink", label: "ピンクのテープ", icon: "minus" },
          { kind: "tape-grid", label: "方眼のテープ", icon: "grid-3x3" },
          { kind: "tape-floral", label: "花柄のテープ", icon: "flower" },
          { kind: "sticky-note", label: "付箋", icon: "sticky-note" },
          { kind: "label-memo", label: "MEMO", icon: "tag" },
          { kind: "label-todo", label: "やること", icon: "list-todo" },
          { kind: "label-heart", label: "ハートのラベル", icon: "heart-handshake" },
        ]
      },
      {
        title: "☀️ 天気と気分",
        items: [
          { kind: "emoji-sun", label: "晴れ", icon: "sun" },
          { kind: "emoji-cloud", label: "曇り", icon: "cloud" },
          { kind: "emoji-rain", label: "雨", icon: "cloud-rain" },
          { kind: "emoji-rainbow", label: "虹", icon: "rainbow" },
          { kind: "emoji-smile", label: "笑顔", icon: "smile" },
          { kind: "emoji-laugh", label: "楽しい", icon: "laugh" },
          { kind: "emoji-heart-eyes", label: "好き", icon: "heart" },
          { kind: "emoji-thinking", label: "考え中", icon: "brain" },
          { kind: "emoji-sad", label: "悲しい", icon: "frown" },
          { kind: "emoji-party", label: "お祝い", icon: "party-popper" }
        ]
      },
      {
        title: "✨ 飾りとアイコン",
        items: [
          { kind: "flower", label: "花", icon: "flower-2" },
          { kind: "paperclip", label: "クリップ", icon: "paperclip" },
          { kind: "emoji-sparkles", label: "きらきら", icon: "sparkles" },
          { kind: "emoji-star", label: "星", icon: "star" },
          { kind: "icon-heart", label: "ピンクのハート", icon: "heart" },
          { kind: "icon-star", label: "黄の星", icon: "star" }
        ]
      }
    ];
  }

  private async getStandaloneCustomStickerAssets(): Promise<any[]> {
    const folder = normalizePath((this.plugin as any).getCustomStickerFolder()).replace(/^\/+|\/+$/g, "");
    if (!folder) return [];

    const manifestItems = await this.readCustomStickerManifestItems(folder);
    const assets: any[] = [];
    const seenPaths = new Set<string>();

    for (const item of manifestItems) {
      if (!item || typeof item !== "object") continue;

      const record = item as Record<string, unknown>;
      const rawPath = typeof record.path === "string" ? record.path.trim() : "";
      if (!rawPath) continue;

      const path = this.resolveCustomStickerAssetPath(folder, rawPath);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !this.isImageFile(file)) continue;

      seenPaths.add(file.path);
      assets.push({
        id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : file.path,
        label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : file.basename,
        path: file.path,
        file,
        category: typeof record.category === "string" && record.category.trim() ? record.category.trim() : "カスタム",
        width: this.readPositiveManifestNumber(record.width),
        height: this.readPositiveManifestNumber(record.height),
        rotation: this.readManifestNumber(record.rotation)
      });
    }

    const files = this.app.vault.getFiles()
      .filter((file) => this.isImageFile(file) && this.isPathInFolder(file.path, folder) && !seenPaths.has(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      assets.push({
        id: file.path,
        label: file.basename,
        path: file.path,
        file,
        category: "カスタム"
      });
    }

    return assets.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
  }

  private async readCustomStickerManifestItems(folder: string): Promise<unknown[]> {
    for (const fileName of ["manifest.json", "components.json"]) {
      const path = normalizePath(`${folder}/${fileName}`);
      if (!(await this.app.vault.adapter.exists(path))) continue;

      try {
        const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as { items?: unknown };
        return Array.isArray(parsed.items) ? parsed.items : [];
      } catch (error) {
        console.warn("Note Ink: failed to read custom sticker manifest", error);
        new Notice(`ステッカーの設定を読み込めません：${path}`);
        return [];
      }
    }

    return [];
  }

  private resolveCustomStickerAssetPath(folder: string, rawPath: string): string {
    const normalized = normalizePath(rawPath);
    if (normalized.startsWith(`${folder}/`)) return normalized;
    if (normalized.includes("/")) return normalized;
    return normalizePath(`${folder}/${normalized}`);
  }

  private readPositiveManifestNumber(value: unknown): number | undefined {
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
  }

  private readManifestNumber(value: unknown): number | undefined {
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  private isPathInFolder(path: string, folder: string): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedFolder = normalizePath(folder).replace(/^\/+|\/+$/g, "");
    return normalizedFolder.length > 0 && normalizedPath.startsWith(`${normalizedFolder}/`);
  }

  private showMenuAtInputEvent(menu: Menu, event?: MouseEvent | TouchEvent): void {
    if (event instanceof MouseEvent) {
      menu.showAtMouseEvent(event);
      return;
    }

    if (event instanceof TouchEvent) {
      const touch = event.changedTouches.item(0) ?? event.touches.item(0);
      if (touch) {
        menu.showAtPosition({ x: touch.clientX, y: touch.clientY });
        return;
      }
    }

    menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  

  private getStandaloneShapeDefaults(shape: StandaloneShapeKind): {
    width: number;
    height: number;
    fill: string;
    stroke: string;
    strokeWidth: number;
    opacity: number;
    borderRadius: number;
  } {
    if (shape === "line") {
      return { width: 220, height: 36, fill: "transparent", stroke: "#8fb36d", strokeWidth: 4, opacity: 1, borderRadius: 0 };
    }
    if (shape === "ellipse") {
      return { width: 140, height: 100, fill: "rgba(255,255,255,0.42)", stroke: "#8fb36d", strokeWidth: 2, opacity: 1, borderRadius: 999 };
    }
    if (shape === "note") {
      return { width: 240, height: 150, fill: "rgba(255,247,214,0.86)", stroke: "#d6bd7a", strokeWidth: 2, opacity: 1, borderRadius: 8 };
    }
    return { width: 220, height: 130, fill: "rgba(255,255,255,0.58)", stroke: "#8fb36d", strokeWidth: 2, opacity: 1, borderRadius: 8 };
  }

  

  private getStandaloneStickerDefaults(sticker: StandaloneStickerKind): {
    width: number;
    height: number;
    rotation: number;
    opacity: number;
    text?: string;
  } {
    if (sticker.startsWith("tape-")) return { width: 140, height: 32, rotation: Math.random() * 6 - 3, opacity: 0.95 };
    if (sticker === "sticky-note") return { width: 150, height: 110, rotation: -2, opacity: 0.98 };
    if (sticker === "label-memo") return { width: 160, height: 120, rotation: 1, opacity: 1 };
    if (sticker === "label-todo") return { width: 130, height: 160, rotation: -1, opacity: 1 };
    if (sticker === "label-heart") return { width: 120, height: 42, rotation: 2, opacity: 1 };
    if (sticker === "paperclip") return { width: 44, height: 82, rotation: -8, opacity: 1 };
    if (sticker === "flower") return { width: 86, height: 86, rotation: 0, opacity: 1 };
    const emojiText = ((...args: any[]) => (null as any))(sticker);
    if (emojiText) return { width: 72, height: 72, rotation: 0, opacity: 1, text: emojiText };
    return { width: 70, height: 70, rotation: sticker === "icon-heart" ? -6 : 8, opacity: 1 };
  }

  private isImageFile(file: TFile): boolean {
    return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.path);
  }

  private async insertStandaloneImage(file: TFile): Promise<void> {
    if (!this.annotation || !this.standalone) return;

    const pageNumber = ((...args: any[]) => (null as any))();
    const pageWidth = Math.max(320, Math.ceil(this.annotation.pageWidth || this.pageLogicalWidth));
    const pageHeight = Math.max(480, Math.ceil(this.annotation.pageHeight || this.pageLogicalHeight));
    const source = this.app.vault.getResourcePath(file);
    const natural = await this.getImageNaturalSize(source);
    const maxWidth = Math.min(320, pageWidth * 0.62);
    const maxHeight = Math.min(260, pageHeight * 0.34);
    const ratio = natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 4 / 3;
    let width = maxWidth;
    let height = width / ratio;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * ratio;
    }

    const pageTop = ((...args: any[]) => (null as any))(pageNumber);
    const visible = this.getVisibleLogicalYRange();
    const visibleCenterY = Math.max(pageTop, Math.min(pageTop + pageHeight, (visible.top + visible.bottom) / 2));
    const element: StandaloneElement = {
      id: crypto.randomUUID(),
      type: "image",
      pageNumber,
      sourcePath: file.path,
      x: Math.max(16, Math.min(pageWidth - width - 16, pageWidth / 2 - width / 2)),
      y: Math.max(16, Math.min(pageHeight - height - 16, visibleCenterY - pageTop - height / 2)),
      width,
      height,
      rotation: 0,
      zIndex: this.getNextStandaloneElementZIndex(),
      opacity: 1
    };

    this.annotation.elements = [...(this.annotation.elements ?? []), element];
    this.selectedStandaloneElementId = element.id;
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  

  private getStandaloneCustomStickerSize(
    asset: any,
    natural: { width: number; height: number },
    pageWidth: number,
    pageHeight: number
  ): { width: number; height: number } {
    const ratio = natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 1;
    let width = asset.width;
    let height = asset.height;

    if (width && !height) height = width / ratio;
    if (height && !width) width = height * ratio;
    if (!width || !height) {
      width = Math.min(180, pageWidth * 0.42);
      height = width / ratio;
    }

    const maxWidth = Math.min(300, pageWidth * 0.7);
    const maxHeight = Math.min(260, pageHeight * 0.36);
    const scale = Math.min(1, maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
    return {
      width: Math.max(24, width * scale),
      height: Math.max(24, height * scale)
    };
  }

  private async getImageNaturalSize(source: string): Promise<{ width: number; height: number }> {
    try {
      const image = await this.loadImage(source);
      return {
        width: image.naturalWidth || image.width || 1,
        height: image.naturalHeight || image.height || 1
      };
    } catch {
      return { width: 4, height: 3 };
    }
  }

  private getNextStandaloneElementZIndex(): number {
    return Math.max(0, ...(this.annotation?.elements ?? []).map((element) => element.zIndex ?? 0)) + 1;
  }

  

  private openStandaloneElementContextMenu(event: MouseEvent, id: string): void {
    const element = this.getStandaloneElementById(id);
    if (!element) return;

    event.preventDefault();
    event.stopPropagation();
    this.selectedStandaloneElementId = id;
    ((...args: any[]) => (null as any))();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("最前面に移動").setIcon("bring-to-front").onClick(() => this.moveStandaloneElementLayer(id, "front")));
    menu.addItem((item) => item.setTitle("一つ前に移動").setIcon("move-up").onClick(() => this.moveStandaloneElementLayer(id, "forward")));
    menu.addItem((item) => item.setTitle("一つ後ろに移動").setIcon("move-down").onClick(() => this.moveStandaloneElementLayer(id, "backward")));
    menu.addItem((item) => item.setTitle("最背面に移動").setIcon("send-to-back").onClick(() => this.moveStandaloneElementLayer(id, "back")));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("透明度 100%").setIcon("circle").setChecked(((...args: any[]) => (null as any))(element) >= 0.99).onClick(() => this.setStandaloneElementOpacityById(id, 1)));
    menu.addItem((item) => item.setTitle("透明度 80%").setIcon("circle").setChecked(Math.abs(((...args: any[]) => (null as any))(element) - 0.8) < 0.01).onClick(() => this.setStandaloneElementOpacityById(id, 0.8)));
    menu.addItem((item) => item.setTitle("透明度 60%").setIcon("circle").setChecked(Math.abs(((...args: any[]) => (null as any))(element) - 0.6) < 0.01).onClick(() => this.setStandaloneElementOpacityById(id, 0.6)));
    menu.addItem((item) => item.setTitle("透明度 40%").setIcon("circle").setChecked(Math.abs(((...args: any[]) => (null as any))(element) - 0.4) < 0.01).onClick(() => this.setStandaloneElementOpacityById(id, 0.4)));
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("削除")
        .setIcon("trash-2")
        .onClick(() => this.deleteStandaloneElement(id));
    });

    menu.showAtMouseEvent(event);
  }

  private openStandaloneElementSettingsModal(id: string): void {
    const element = this.getStandaloneElementById(id);
    if (!element) return;

    (null as any)(this.app, {
      width: element.width,
      height: element.height,
      rotation: element.rotation ?? 0,
      opacity: ((...args: any[]) => (null as any))(element)
    }, (draft: any) => this.applyStandaloneElementSettings(id, draft)).open();
  }

  private applyStandaloneElementSettings(id: string, draft: any): void {
    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    element.width = Math.max(24, draft.width);
    element.height = Math.max(24, draft.height);
    element.rotation = this.normalizeStandaloneElementRotation(draft.rotation);
    this.setStandaloneElementOpacity(element, draft.opacity);
    this.clampStandaloneElementToPage(element);
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  

  private setStandaloneElementOpacity(element: StandaloneElement, opacity: number): void {
    element.opacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
  }

  private setStandaloneElementOpacityById(id: string, opacity: number): void {
    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    this.setStandaloneElementOpacity(element, opacity);
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  private scaleStandaloneElement(id: string, widthFactor: number, heightFactor: number): void {
    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    const oldWidth = element.width;
    const oldHeight = element.height;
    element.width = Math.max(24, element.width * widthFactor);
    element.height = Math.max(24, element.height * heightFactor);
    element.x += (oldWidth - element.width) / 2;
    element.y += (oldHeight - element.height) / 2;
    this.clampStandaloneElementToPage(element);
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  private rotateStandaloneElement(id: string, deltaDegrees: number): void {
    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    element.rotation = this.normalizeStandaloneElementRotation((element.rotation ?? 0) + deltaDegrees);
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  private setStandaloneElementRotation(id: string, degrees: number): void {
    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    element.rotation = this.normalizeStandaloneElementRotation(degrees);
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  private normalizeStandaloneElementRotation(degrees: number): number {
    if (!Number.isFinite(degrees)) return 0;
    const normalized = ((degrees % 360) + 360) % 360;
    return Math.abs(normalized) < 0.001 ? 0 : normalized;
  }

  private moveStandaloneElementLayer(id: string, action: "front" | "back" | "forward" | "backward"): void {
    if (!this.annotation?.elements) return;

    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    const pageElements = this.annotation.elements
      .filter((item) => item.pageNumber === element.pageNumber)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    const index = pageElements.findIndex((item) => item.id === id);
    if (index === -1) return;

    const ordered = [...pageElements];
    const [current] = ordered.splice(index, 1);
    if (!current) return;

    if (action === "front") {
      ordered.push(current);
    } else if (action === "back") {
      ordered.unshift(current);
    } else if (action === "forward") {
      ordered.splice(Math.min(index + 1, ordered.length), 0, current);
    } else {
      ordered.splice(Math.max(index - 1, 0), 0, current);
    }

    ordered.forEach((item, itemIndex) => {
      item.zIndex = (itemIndex + 1) * 10;
    });
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  private getStandaloneElementClientCenter(element: StandaloneElement): PagePoint | null {
    const page = this.getPageCoordinateElement();
    if (!page) return null;

    const rect = page.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const scaleX = rect.width / Math.max(1, this.pageLogicalWidth);
    const scaleY = rect.height / Math.max(1, this.pageLogicalHeight);
    const pageTop = ((...args: any[]) => (null as any))(element.pageNumber);
    return {
      x: rect.left + (element.x + element.width / 2) * scaleX,
      y: rect.top + (pageTop + element.y + element.height / 2) * scaleY
    };
  }

  private beginStandaloneElementDrag(event: PointerEvent, id: string, mode: any["mode"]): void {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (mode === "move" && this.shouldWriteOnStandaloneElement(event)) return;

    const element = this.getStandaloneElementById(id);
    if (!element || element.locked) return;

    const center = this.getStandaloneElementClientCenter(element);
    const startAngle = center
      ? Math.atan2(event.clientY - center.y, event.clientX - center.x)
      : undefined;

    event.preventDefault();
    event.stopPropagation();
    this.selectedStandaloneElementId = id;
    ((...args: any[]) => (null as any))();
    this.engine?.setInputEnabled(false);

    this.standaloneElementDrag = {
      id,
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: element.x,
      startY: element.y,
      startWidth: element.width,
      startHeight: element.height,
      startRotation: element.rotation ?? 0,
      startAngle,
      centerClientX: center?.x,
      centerClientY: center?.y
    };

    window.addEventListener("pointermove", ((...args: any[]) => (null as any)), { capture: true });
    window.addEventListener("pointerup", ((...args: any[]) => (null as any)), { capture: true });
    window.addEventListener("pointercancel", ((...args: any[]) => (null as any)), { capture: true });
  }

  private shouldWriteOnStandaloneElement(event: PointerEvent): boolean {
    if (!this.isStandaloneInkWritingMode()) return false;
    if (event.pointerType === "mouse") return true;
    if (event.pointerType === "pen") return true;
    if (event.pointerType !== "touch") return false;

    return this.engine?.getToolState().acceptTouchInput === true;
  }

  private isStandaloneInkWritingMode(): boolean {
    return this.standalone
      && !this.browseMode
      && !this.selectMode
      && !this.strokeSelectMode
      && !this.captureMode;
  }

  

  

  private getStandaloneElementById(id: string): StandaloneElement | null {
    return (this.annotation?.elements ?? []).find((element) => element.id === id) ?? null;
  }

  private clampStandaloneElementToPage(element: StandaloneElement): void {
    const pageWidth = Math.max(320, Math.ceil(this.annotation?.pageWidth || this.pageLogicalWidth));
    const pageHeight = Math.max(480, Math.ceil(this.annotation?.pageHeight || this.pageLogicalHeight));
    element.width = Math.max(24, Math.min(element.width, pageWidth));
    element.height = Math.max(24, Math.min(element.height, pageHeight));
    element.x = Math.max(0, Math.min(element.x, pageWidth - element.width));
    element.y = Math.max(0, Math.min(element.y, pageHeight - element.height));
  }

  private deleteStandaloneElement(id: string): void {
    if (!this.annotation?.elements) return;

    this.annotation.elements = this.annotation.elements.filter((element) => element.id !== id);
    if (this.selectedStandaloneElementId === id) {
      this.selectedStandaloneElementId = null;
    }
    ((...args: any[]) => (null as any))();
    this.saveQueue?.markDirty();
  }

  

  

  /** Get the 1-indexed page number currently most visible in the viewport */
  

  /** Delete a specific page (1-indexed) from the standalone note */
  

  private async renderMarkdownBackground(file: TFile, background: HTMLElement): Promise<void> {
    const markdown = await this.app.vault.cachedRead(file);
    this.currentMarkdownSourceHash = stableHash(markdown);
    this.markdownTextItems = [];
    background.empty();
    await MarkdownRenderer.render(this.app, markdown, background, file.path, this);
    await nextFrame();
    await waitForImages(background);
    await this.waitForStableMarkdownLayout(background);
  }

  private isSavedMarkdownLayoutCompatible(annotation: AnnotationFile, file: TFile): boolean {
    const layout = this.savedMarkdownLayout;
    if (!layout) return false;

    if (layout.sourceHash && this.currentMarkdownSourceHash) {
      return layout.sourceHash === this.currentMarkdownSourceHash;
    }

    return annotation.sourceMtime === file.stat.mtime;
  }

  private async renderPdfBackground(file: TFile, scroll: HTMLElement, background: HTMLElement, token: number): Promise<{ width: number; height: number }> {
    await nextFrame();

    const pdfjsLib = await loadPdfJs() as PdfJsLib;
    const data = new Uint8Array(await this.app.vault.readBinary(file));
    if (data.byteLength > 100 * 1024 * 1024) throw new Error("100MBを超えるPDFは、この版では開けません。");
    const pdf = await pdfjsLib.getDocument(this.createPdfJsDocumentSource(data)).promise;
    if (pdf.numPages > MAX_PDF_PAGES) { await pdf.destroy?.(); throw new Error("1000ページを超えるPDFは分割して開いてください。"); }
    const availableWidth = Math.max(320, scroll.clientWidth - 24);
    const maxWidth = this.isMobileLike() ? PDF_BACKGROUND_MOBILE_MAX_WIDTH : PDF_BACKGROUND_DESKTOP_MAX_WIDTH;
    const targetWidth = Math.min(Math.max(availableWidth, 320), maxWidth);
    const firstPage = await pdf.getPage(1);
    const firstBaseViewport = firstPage.getViewport({ scale: 1 });
    const firstScale = targetWidth / Math.max(1, firstBaseViewport.width);
    const estimatedViewport = firstPage.getViewport({ scale: firstScale });
    const estimatedPageWidth = Math.max(1, Math.ceil(estimatedViewport.width));
    const estimatedPageHeight = Math.max(1, Math.ceil(estimatedViewport.height));
    try { assertDimensions(estimatedPageWidth,estimatedPageHeight,MAX_PDF_PAGE_HEIGHT); }
    catch (error) { await pdf.destroy?.(); throw error; }
    let totalHeight = 0;
    this.pdfBackgroundDocument = pdf;
    this.pdfBackgroundTargetWidth = targetWidth;
    this.pdfBackgroundPages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (token !== this.pdfRenderToken) break;

      const offsetY = totalHeight;
      const pageEl = background.createDiv({ cls: "mobile-ink-pdf-page-background" });
      pageEl.dataset.mobileInkPdfPage = String(pageNumber);
      pageEl.style.width = `${estimatedPageWidth}px`;
      pageEl.style.height = `${estimatedPageHeight}px`;
      pageEl.style.marginBottom = pageNumber === pdf.numPages ? "0" : `${PDF_BACKGROUND_PAGE_GAP}px`;
      pageEl.createDiv({ cls: "mobile-ink-pdf-page-loading", text: `PDF ${pageNumber}/${pdf.numPages}` });

      const canvas = pageEl.createEl("canvas", {
        cls: "mobile-ink-pdf-page-canvas",
        attr: { "aria-label": `PDFの${pageNumber}ページ` }
      });
      canvas.style.width = `${estimatedPageWidth}px`;
      canvas.style.height = `${estimatedPageHeight}px`;
      const annotationLayer = pageEl.createDiv({
        cls: "mobile-ink-pdf-text-annotation-layer",
        attr: { "aria-hidden": "true" }
      });
      const textLayer = pageEl.createDiv({
        cls: "mobile-ink-pdf-text-layer",
        attr: { "aria-label": `PDFの${pageNumber}ページの文字` }
      });
      this.pdfBackgroundPages.push({
        pageNumber,
        page: pageNumber === 1 ? firstPage : undefined,
        viewport: { ...estimatedViewport },
        offsetY,
        canvas,
        textLayer,
        textItems: [],
        annotationLayer,
        pageEl,
        renderedQuality: "none",
        rendering: false,
        textRendered: false,
        textRendering: false,
        renderTask: undefined
      });

      totalHeight += estimatedPageHeight;
      if (pageNumber < pdf.numPages) {
        totalHeight += PDF_BACKGROUND_PAGE_GAP;
      }

      if (pageNumber % 20 === 0) {
        await this.yieldToBrowser();
      }
    }

    return {
      width: targetWidth,
      height: Math.max(480, totalHeight)
    };
  }

  private createPdfJsDocumentSource(data: Uint8Array): PdfJsDocumentSource {
    return {data, isEvalSupported:false, useWorkerFetch:false,
      CMapReaderFactory:BundledCMapReaderFactory, StandardFontDataFactory:BundledStandardFontDataFactory};
  }

  private attachPdfLazyRenderer(scroll: HTMLElement): void {
    if (this.pdfScrollEl && this.pdfScrollEl !== scroll) {
      this.pdfScrollEl.removeEventListener("scroll", this.onPdfScroll);
    }
    this.detachPdfPageObserver();

    this.pdfScrollEl = scroll;
    scroll.addEventListener("scroll", this.onPdfScroll, { passive: true });
    this.attachPdfPageObserver(scroll);
    window.setTimeout(() => this.queueVisiblePdfPagesRender(), 0);
  }

  private detachPdfLazyRenderer(): void {
    this.pdfRenderToken++;
    this.detachPdfPageObserver();
    if (this.pdfScrollEl) {
      this.pdfScrollEl.removeEventListener("scroll", this.onPdfScroll);
      this.pdfScrollEl = null;
    }
    if (this.pdfLazyRenderRaf !== null) {
      cancelAnimationFrame(this.pdfLazyRenderRaf);
      this.pdfLazyRenderRaf = null;
    }
    if (this.pdfSharpRenderTimer !== null) {
      window.clearTimeout(this.pdfSharpRenderTimer);
      this.pdfSharpRenderTimer = null;
    }
    this.pdfVisibleRenderRunning = false;
    this.pdfVisibleRenderQueued = false;
    this.pdfSharpRenderRunning = false;
    for (const entry of this.pdfBackgroundPages) {
      this.releasePdfBackgroundEntry(entry, true);
    }
    this.clearPdfDocumentCleanupTimer();
    this.pdfBackgroundPages = [];
    const documentToDestroy = this.pdfBackgroundDocument;
    this.pdfBackgroundDocument = null;
    this.pdfBackgroundTargetWidth = 1;

    if (documentToDestroy?.destroy) {
      void Promise.resolve(documentToDestroy.destroy()).catch((error) => {
        console.warn("Note Ink: failed to destroy PDF document", error);
      });
    }
  }

  private attachPdfPageObserver(scroll: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined" || this.pdfBackgroundPages.length === 0) return;

    const mobile = this.isMobileLike();
    const verticalMargin = mobile
      ? this.isLongMobilePdf()
        ? Math.max(96, Math.round(scroll.clientHeight * 0.28))
        : Math.max(160, Math.round(scroll.clientHeight * 0.55))
      : Math.max(720, Math.round(scroll.clientHeight * 1.3));

    this.pdfObservedNearPages.clear();
    this.pdfPageObserver = new IntersectionObserver(this.onPdfPageIntersection, {
      root: scroll,
      rootMargin: `${verticalMargin}px 0px ${verticalMargin}px 0px`,
      threshold: 0
    });

    for (const entry of this.pdfBackgroundPages) {
      this.pdfPageObserver.observe(entry.pageEl);
    }
  }

  private detachPdfPageObserver(): void {
    this.pdfPageObserver?.disconnect();
    this.pdfPageObserver = null;
    this.pdfObservedNearPages.clear();
  }

  private onPdfPageIntersection = (entries: IntersectionObserverEntry[]): void => {
    if (this.pdfBackgroundPages.length === 0) return;

    let changed = false;
    for (const observed of entries) {
      if (!(observed.target instanceof HTMLElement)) continue;

      const pageNumber = Number.parseInt(observed.target.dataset.mobileInkPdfPage ?? "", 10);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;

      if (observed.isIntersecting) {
        if (!this.pdfObservedNearPages.has(pageNumber)) {
          this.pdfObservedNearPages.add(pageNumber);
          changed = true;
        }
        continue;
      }

      if (this.pdfObservedNearPages.delete(pageNumber)) {
        changed = true;
      }
      const entry = this.pdfBackgroundPages[pageNumber - 1];
      if (entry && (entry.renderedQuality !== "none" || entry.textRendered || entry.rendering)) {
        this.releasePdfBackgroundEntry(entry, true);
      }
    }

    if (!changed) return;
    this.queueVisiblePdfPagesRender();
    this.queueVisiblePdfTextLayersRender();
    this.pdfPageNavigator.queueUpdate();
  };

  private detachPdfPageNavigator(): void {
    this.pdfPageNavigator.detach();
  }

  private getPdfPageNavigatorPages(): PdfPageNavigatorPage[] {
    return this.pdfBackgroundPages.map((entry) => ({
      pageNumber: entry.pageNumber,
      offsetY: entry.offsetY,
      height: Math.max(1, entry.viewport.height)
    }));
  }

  private goToPdfPage(pageNumber: number): void {
    const scroll = this.scrollEl;
    if (!scroll || this.pdfBackgroundPages.length === 0) return;

    const targetPage = Math.min(Math.max(Math.floor(pageNumber), 1), this.pdfBackgroundPages.length);
    const entry = this.pdfBackgroundPages[targetPage - 1];
    if (!entry) return;

    this.closeToolbarPopovers();
    this.clearPdfTextSelectionUi();
    this.markPdfInteractionBusy();
    const frameTop = this.pageFrameEl?.offsetTop ?? 0;
    scroll.scrollTop = Math.max(0, frameTop + entry.offsetY * this.zoom);
    this.pdfPageNavigator.setCurrentPageNumber(targetPage);
    this.pdfPageNavigator.updateNow();
    this.queueVisiblePdfPagesRender();
    ((...args: any[]) => (null as any))();
    this.scheduleSharpPdfBackgroundRender();
  }

  private onPdfScroll = (): void => {
    this.markPdfInteractionBusy();
    if (this.pinchZoomState) return;
    this.queueVisiblePdfPagesRender();
    this.queueVisiblePdfTextLayersRender();
    this.pdfPageNavigator.queueUpdate();
  };

  private markPdfInteractionBusy(): void {
    this.pdfInteractionBusyUntil = performance.now() + PDF_BACKGROUND_SHARP_IDLE_MS;
    if (this.pdfSharpRenderTimer !== null) {
      window.clearTimeout(this.pdfSharpRenderTimer);
      this.pdfSharpRenderTimer = null;
    }
  }

  private queueVisiblePdfPagesRender(): void {
    if (this.pdfLazyRenderRaf !== null || this.pdfBackgroundPages.length === 0) return;
    if (this.pinchZoomState) return;
    if (this.pdfVisibleRenderRunning) {
      this.pdfVisibleRenderQueued = true;
      return;
    }

    this.pdfLazyRenderRaf = requestAnimationFrame(() => {
      this.pdfLazyRenderRaf = null;
      void this.renderVisiblePdfBackgroundPages();
    });
  }

  private async renderVisiblePdfBackgroundPages(): Promise<void> {
    const scroll = this.pdfScrollEl;
    if (!scroll || this.pdfBackgroundPages.length === 0) return;
    if (this.pdfVisibleRenderRunning) {
      this.pdfVisibleRenderQueued = true;
      return;
    }

    this.pdfVisibleRenderRunning = true;
    try {
      const token = this.pdfRenderToken;
      const mobile = this.isMobileLike();
      const preloadMarginPx = mobile
        ? this.isLongMobilePdf()
          ? Math.max(scroll.clientHeight * 0.08, 64)
          : Math.max(scroll.clientHeight * 0.2, 120)
        : Math.max(scroll.clientHeight * 1.2, 720);
      const preloadMargin = preloadMarginPx / Math.max(0.001, this.zoom);
      const visibleRange = this.getVisibleLogicalYRange();
      const viewportCenter = (visibleRange.top + visibleRange.bottom) / 2;
      if (this.pdfObservedNearPages.size > 0) {
        this.releaseUnobservedPdfBackgroundPages();
      } else {
        this.releaseFarPdfBackgroundPages(
          visibleRange,
          (mobile
            ? this.isLongMobilePdf()
              ? scroll.clientHeight * 0.45
              : scroll.clientHeight * 0.72
            : scroll.clientHeight * 3) / Math.max(0.001, this.zoom)
        );
      }
      this.enforcePdfRenderedPageBudget(visibleRange);
      const candidates = this.getPdfRenderCandidatePages(visibleRange, preloadMargin)
        .filter((entry) => entry.renderedQuality === "none" && !entry.rendering)
        .map((entry) => ({
          entry,
          distance: Math.abs(entry.offsetY + entry.viewport.height / 2 - viewportCenter)
        }))
        .sort((a, b) => a.distance - b.distance)
        .map(({ entry }) => entry);
      const renderLimit = mobile ? 1 : 2;
      const selected = candidates.slice(0, renderLimit);

      for (const entry of selected) {
        if (token !== this.pdfRenderToken) return;
        await this.renderPdfBackgroundPage(entry, token, "preview");
        await this.yieldToBrowser();
      }

      this.enforcePdfRenderedPageBudget(this.getVisibleLogicalYRange());
      if (candidates.length > selected.length) {
        this.queueVisiblePdfPagesRender();
      }
      this.scheduleSharpPdfBackgroundRender();
    } finally {
      this.pdfVisibleRenderRunning = false;
      if (this.pdfVisibleRenderQueued) {
        this.pdfVisibleRenderQueued = false;
        this.queueVisiblePdfPagesRender();
      }
    }
  }

  private releaseFarPdfBackgroundPages(visibleRange: { top: number; bottom: number }, keepMargin: number): void {
    for (const entry of this.pdfBackgroundPages) {
      if (entry.renderedQuality === "none" && !entry.rendering && !entry.textRendered) continue;

      if (entry.offsetY + entry.viewport.height >= visibleRange.top - keepMargin
        && entry.offsetY <= visibleRange.bottom + keepMargin) continue;

      this.releasePdfBackgroundEntry(entry, true);
    }
  }

  private getPdfRenderCandidatePages(visibleRange: { top: number; bottom: number }, preloadMargin: number): PdfBackgroundPageEntry[] {
    if (this.pdfObservedNearPages.size > 0) {
      return this.pdfBackgroundPages.filter((entry) => this.pdfObservedNearPages.has(entry.pageNumber));
    }

    return this.pdfBackgroundPages.filter((entry) => entry.offsetY + entry.viewport.height >= visibleRange.top - preloadMargin
      && entry.offsetY <= visibleRange.bottom + preloadMargin);
  }

  private releaseUnobservedPdfBackgroundPages(): void {
    for (const entry of this.pdfBackgroundPages) {
      if (this.pdfObservedNearPages.has(entry.pageNumber)) continue;
      if (entry.renderedQuality === "none" && !entry.rendering && !entry.textRendered) continue;

      this.releasePdfBackgroundEntry(entry, true);
    }
  }

  private enforcePdfRenderedPageBudget(visibleRange: { top: number; bottom: number }): void {
    const budget = this.getPdfRenderedPageBudget();
    const rendered = this.pdfBackgroundPages
      .filter((entry) => (entry.renderedQuality !== "none" || entry.textRendered) && !entry.rendering)
      .map((entry) => ({
        entry,
        distance: Math.abs(entry.offsetY + entry.viewport.height / 2 - (visibleRange.top + visibleRange.bottom) / 2)
      }))
      .sort((a, b) => a.distance - b.distance);

    for (const item of rendered.slice(budget)) {
      this.releasePdfBackgroundEntry(item.entry);
    }
  }

  private getPdfRenderedPageBudget(): number {
    if (!this.isMobileLike()) return PDF_BACKGROUND_DESKTOP_RENDERED_PAGE_BUDGET;
    return this.isLongMobilePdf()
      ? PDF_BACKGROUND_MOBILE_LONG_DOC_BUDGET
      : PDF_BACKGROUND_MOBILE_DEFAULT_BUDGET;
  }

  private isLongMobilePdf(): boolean {
    return this.isMobileLike() && this.pdfBackgroundPages.length >= PDF_BACKGROUND_MOBILE_LONG_DOC_PAGES;
  }

  private releasePdfBackgroundEntry(entry: PdfBackgroundPageEntry, forceCancel = false): void {
    if (entry.rendering && entry.renderTask?.cancel && forceCancel) {
      try {
        entry.renderTask.cancel();
      } catch {
        // Ignore PDF.js cancellation errors.
      }
    }

    if (entry.rendering && !forceCancel) return;
    const currentPage = this.pdfPageNavigator.getCurrentPageNumber();
    const preserveTextLayer = this.selectMode
      && (entry.pageNumber === currentPage
        || Math.abs(entry.pageNumber - currentPage) <= 1
        || this.pdfObservedNearPages.has(entry.pageNumber));

    entry.canvas.width = 1;
    entry.canvas.height = 1;
    if (!preserveTextLayer) {
      entry.textLayer.empty();
      entry.textItems = [];
      entry.textRendered = false;
      entry.textRendering = false;
    }
    entry.renderedQuality = "none";
    entry.renderTask = undefined;
    entry.page = undefined;
    entry.pageEl.removeClass("mobile-ink-pdf-page-rendered");
    entry.pageEl.removeClass("mobile-ink-pdf-page-sharp");
    this.schedulePdfDocumentCleanup();
  }

  private schedulePdfDocumentCleanup(): void {
    if (!this.isMobileLike() || !this.pdfBackgroundDocument || this.exportingPdf) return;

    if (this.pdfCleanupTimer !== null) {
      window.clearTimeout(this.pdfCleanupTimer);
    }

    this.pdfCleanupTimer = window.setTimeout(() => {
      this.pdfCleanupTimer = null;
      this.cleanupPdfDocumentCaches();
    }, PDF_BACKGROUND_CACHE_CLEANUP_IDLE_MS);
  }

  private cleanupPdfDocumentCaches(): void {
    const pdf = this.pdfBackgroundDocument;
    if (!pdf?.cleanup || this.exportingPdf) return;
    if (this.pdfBackgroundPages.some((entry) => entry.rendering || entry.textRendering)) {
      this.schedulePdfDocumentCleanup();
      return;
    }

    try {
      void Promise.resolve(pdf.cleanup(true)).catch((error) => {
        console.warn("Note Ink: failed to cleanup PDF document caches", error);
      });
    } catch (error) {
      console.warn("Note Ink: failed to cleanup PDF document caches", error);
    }
  }

  private clearPdfDocumentCleanupTimer(): void {
    if (this.pdfCleanupTimer === null) return;

    window.clearTimeout(this.pdfCleanupTimer);
    this.pdfCleanupTimer = null;
  }

  private scheduleSharpPdfBackgroundRender(): void {
    if (this.pdfSharpRenderTimer !== null) {
      window.clearTimeout(this.pdfSharpRenderTimer);
    }

    this.pdfSharpRenderTimer = window.setTimeout(() => {
      this.pdfSharpRenderTimer = null;
      void this.renderSharpVisiblePdfBackgroundPages();
    }, PDF_BACKGROUND_SHARP_IDLE_MS);
  }

  private async renderSharpVisiblePdfBackgroundPages(): Promise<void> {
    const scroll = this.pdfScrollEl;
    if (!scroll || this.pdfBackgroundPages.length === 0) return;
    if (this.pdfVisibleRenderRunning) {
      this.scheduleSharpPdfBackgroundRender();
      return;
    }
    if (this.pdfSharpRenderRunning) return;
    if (this.engine?.isInputActive() || this.pinchZoomState || performance.now() < this.pdfInteractionBusyUntil) {
      this.scheduleSharpPdfBackgroundRender();
      return;
    }

    this.pdfSharpRenderRunning = true;
    try {
      const token = this.pdfRenderToken;
      const visibleRange = this.getVisibleLogicalYRange();
      const viewportCenter = (visibleRange.top + visibleRange.bottom) / 2;
      const marginPx = this.isLongMobilePdf()
        ? Math.max(scroll.clientHeight * 0.04, 32)
        : Math.max(scroll.clientHeight * 0.18, 120);
      const margin = marginPx / Math.max(0.001, this.zoom);
      const candidates = this.pdfBackgroundPages
        .filter((entry) => entry.renderedQuality !== "sharp" && !entry.rendering)
        .map((entry) => ({
          entry,
          distance: Math.abs(entry.offsetY + entry.viewport.height / 2 - viewportCenter)
        }))
        .filter(({ entry }) => entry.offsetY + entry.viewport.height >= visibleRange.top - margin
          && entry.offsetY <= visibleRange.bottom + margin)
        .sort((a, b) => a.distance - b.distance)
        .map(({ entry }) => entry);

      const limit = this.isMobileLike() ? 1 : 2;
      const selected = candidates.slice(0, limit);
      for (const entry of selected) {
        if (token !== this.pdfRenderToken) return;
        await this.renderPdfBackgroundPage(entry, token, "sharp");
        await this.yieldToBrowser();
      }

      this.enforcePdfRenderedPageBudget(this.getVisibleLogicalYRange());
      if (candidates.length > selected.length) {
        this.scheduleSharpPdfBackgroundRender();
      }
    } finally {
      this.pdfSharpRenderRunning = false;
    }
  }

  

  private async renderPdfBackgroundPage(entry: PdfBackgroundPageEntry, token: number, quality: Exclude<PdfRenderQuality, "none">): Promise<void> {
    if (entry.rendering || token !== this.pdfRenderToken) return;
    if (entry.renderedQuality === "sharp" || (quality === "preview" && entry.renderedQuality !== "none")) return;

    entry.rendering = true;
    entry.pageEl.addClass("mobile-ink-pdf-page-rendering");
    try {
      const width = Math.max(1, Math.ceil(entry.viewport.width));
      const height = Math.max(1, Math.ceil(entry.viewport.height));
      const outputScale = this.getPdfBackgroundOutputScale(width, height, quality);
      entry.canvas.width = Math.max(1, Math.ceil(width * outputScale));
      entry.canvas.height = Math.max(1, Math.ceil(height * outputScale));
      entry.canvas.style.width = `${width}px`;
      entry.canvas.style.height = `${height}px`;

      const ctx = entry.canvas.getContext("2d", { alpha: false });
      if (!ctx) {
        throw new Error("Unable to create PDF page canvas context");
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, entry.canvas.width, entry.canvas.height);
      ctx.restore();

      if (!entry.page) {
        if (!this.pdfBackgroundDocument) {
          throw new Error("PDF document is unavailable");
        }
        entry.page = await this.pdfBackgroundDocument.getPage(entry.pageNumber);
      }

      const baseViewport = entry.page.getViewport({ scale: 1 });
      const fitScale = Math.min(
        this.pdfBackgroundTargetWidth / Math.max(1, baseViewport.width),
        height / Math.max(1, baseViewport.height)
      );
      const renderViewport = entry.page.getViewport({ scale: fitScale });
      const offsetX = Math.max(0, (width - renderViewport.width) / 2);
      const offsetY = Math.max(0, (height - renderViewport.height) / 2);
      const transform: [number, number, number, number, number, number] | undefined = outputScale === 1
        ? offsetX || offsetY
          ? [1, 0, 0, 1, offsetX, offsetY]
          : undefined
        : [outputScale, 0, 0, outputScale, offsetX * outputScale, offsetY * outputScale];
      const renderTask = entry.page.render({ canvasContext: ctx, viewport: renderViewport, transform });
      entry.renderTask = renderTask;
      await renderTask.promise;
      if (token !== this.pdfRenderToken) return;

      entry.renderedQuality = quality;
      entry.pageEl.addClass("mobile-ink-pdf-page-rendered");
      entry.pageEl.classList.toggle("mobile-ink-pdf-page-sharp", quality === "sharp");
      if (this.selectMode) {
        void this.renderPdfTextLayer(entry, token);
      }
      this.renderPdfTextAnnotationsForPage(entry);
    } catch (error) {
      if (!this.isPdfRenderCancelled(error)) {
        console.error(`Note Ink: failed to render PDF page ${entry.pageNumber}`, error);
        entry.pageEl.addClass("mobile-ink-pdf-page-error");
      }
    } finally {
      entry.renderTask = undefined;
      entry.rendering = false;
      entry.pageEl.removeClass("mobile-ink-pdf-page-rendering");
    }
  }

  private isPdfRenderCancelled(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === "RenderingCancelledException"
      || error.message.toLowerCase().includes("cancel");
  }

  

  

  

  

  

  

  

  

  

  private preparePdfInkStrokesForCurrentLayout(strokes: InkStroke[], savedPageWidth: number, savedPageHeight: number): InkStroke[] {
    if (strokes.length === 0 || this.pdfBackgroundPages.length === 0) {
      return strokes.map((stroke: any) => this.cloneStroke(stroke));
    }

    const sourceWidth = Number.isFinite(savedPageWidth) && savedPageWidth > 0
      ? savedPageWidth
      : this.pageLogicalWidth;
    const sourceHeight = Number.isFinite(savedPageHeight) && savedPageHeight > 0
      ? savedPageHeight
      : this.pageLogicalHeight;
    const sourcePages = this.getPdfSourcePageLayout(sourceWidth);
    if (sourcePages.length === 0) {
      return strokes.map((stroke: any) => this.cloneStroke(stroke));
    }

    return strokes.map((stroke: any) => {
      const sourcePage = this.findPdfSourcePageForStroke(stroke, sourcePages, sourceHeight);
      const targetPage = this.pdfBackgroundPages.find((entry) => entry.pageNumber === sourcePage?.pageNumber);
      if (!sourcePage || !targetPage) return this.cloneStroke(stroke);

      const targetWidth = Math.max(1, Math.ceil(targetPage.viewport.width));
      const targetHeight = Math.max(1, Math.ceil(targetPage.viewport.height));
      const scaleX = targetWidth / sourcePage.width;
      const scaleY = targetHeight / sourcePage.height;
      const widthScale = Math.sqrt(scaleX * scaleY);

      return {
        ...stroke,
        width: Math.max(0.5, stroke.width * widthScale),
        points: stroke.points.map((point: any) => ({
          ...point,
          x: point.x * scaleX,
          y: targetPage.offsetY + (point.y - sourcePage.offsetY) * scaleY
        }))
      };
    });
  }

  private prepareMarkdownInkStrokesForCurrentLayout(strokes: InkStroke[], savedPageWidth: number, _savedPageHeight: number): InkStroke[] {
    if (strokes.length === 0) {
      return [];
    }

    const layoutMappedStrokes = this.prepareMarkdownInkStrokesByLayout(strokes);
    if (layoutMappedStrokes) {
      return layoutMappedStrokes;
    }

    const sourceWidth = Number.isFinite(savedPageWidth) && savedPageWidth > 0
      ? savedPageWidth
      : this.pageLogicalWidth;
    const targetWidth = Math.max(1, this.pageLogicalWidth);
    const scale = targetWidth / Math.max(1, sourceWidth);

    if (Math.abs(scale - 1) < 0.001) {
      return strokes.map((stroke: any) => this.cloneStroke(stroke));
    }

    // Markdown height is a layout result and varies across themes/devices. Only
    // scale ink when the frozen annotation width changes, and keep x/y uniform.
    return strokes.map((stroke: any) => ({
      ...stroke,
      width: Math.max(0.5, stroke.width * scale),
      points: stroke.points.map((point: any) => ({
        ...point,
        x: point.x * scale,
        y: point.y * scale
      }))
    }));
  }

  private prepareMarkdownInkStrokesByLayout(strokes: InkStroke[]): InkStroke[] | null {
    const savedLayout = this.savedMarkdownLayout;
    const currentLayout = this.currentMarkdownLayout;
    if (!savedLayout || !currentLayout || savedLayout.anchors.length === 0 || currentLayout.anchors.length === 0) {
      return null;
    }

    const mapping = this.buildMarkdownLayoutMapping(savedLayout, currentLayout);
    if (mapping.length < 2) return null;

    const sourceWidth = Math.max(1, savedLayout.pageWidth);
    const targetWidth = Math.max(1, currentLayout.pageWidth);
    const scaleX = targetWidth / sourceWidth;

    return strokes.map((stroke: any) => ({
      ...stroke,
      width: Math.max(0.5, stroke.width * scaleX),
      points: stroke.points.map((point: any) => ({
        ...point,
        x: point.x * scaleX,
        y: this.mapMarkdownLayoutY(point.y, mapping)
      }))
    }));
  }

  private buildMarkdownLayoutMapping(
    savedLayout: MarkdownLayoutSnapshot,
    currentLayout: MarkdownLayoutSnapshot
  ): Array<{ sourceY: number; targetY: number }> {
    const currentAnchors = new Map(currentLayout.anchors.map((anchor) => [anchor.key, anchor]));
    const pairs: Array<{ sourceY: number; targetY: number }> = [
      { sourceY: 0, targetY: 0 },
      { sourceY: Math.max(1, savedLayout.pageHeight), targetY: Math.max(1, currentLayout.pageHeight) }
    ];

    for (const savedAnchor of savedLayout.anchors) {
      const currentAnchor = currentAnchors.get(savedAnchor.key);
      if (!currentAnchor) continue;

      pairs.push({
        sourceY: savedAnchor.y,
        targetY: currentAnchor.y
      });
      pairs.push({
        sourceY: savedAnchor.y + savedAnchor.height,
        targetY: currentAnchor.y + currentAnchor.height
      });
    }

    pairs.sort((a, b) => a.sourceY - b.sourceY || a.targetY - b.targetY);

    const result: Array<{ sourceY: number; targetY: number }> = [];
    for (const pair of pairs) {
      const sourceY = Math.max(0, pair.sourceY);
      const targetY = Math.max(0, pair.targetY);
      const previous = result[result.length - 1];

      if (previous && Math.abs(previous.sourceY - sourceY) < 0.5) {
        previous.targetY = (previous.targetY + targetY) / 2;
        continue;
      }

      if (previous && targetY < previous.targetY - 24) {
        continue;
      }

      result.push({ sourceY, targetY });
    }

    return result;
  }

  private mapMarkdownLayoutY(y: number, mapping: Array<{ sourceY: number; targetY: number }>): number {
    if (mapping.length === 0) return y;
    if (mapping.length === 1) return y - mapping[0].sourceY + mapping[0].targetY;

    if (y <= mapping[0].sourceY) {
      const first = mapping[0];
      const second = mapping[1];
      return this.interpolateMarkdownLayoutY(y, first, second);
    }

    const last = mapping[mapping.length - 1];
    if (y >= last.sourceY) {
      const previous = mapping[mapping.length - 2];
      return this.interpolateMarkdownLayoutY(y, previous, last);
    }

    let low = 0;
    let high = mapping.length - 1;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (mapping[mid].sourceY <= y) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return this.interpolateMarkdownLayoutY(y, mapping[low], mapping[high]);
  }

  private interpolateMarkdownLayoutY(
    y: number,
    start: { sourceY: number; targetY: number },
    end: { sourceY: number; targetY: number }
  ): number {
    const sourceSpan = end.sourceY - start.sourceY;
    if (Math.abs(sourceSpan) < 0.001) return start.targetY;

    const ratio = (y - start.sourceY) / sourceSpan;
    return start.targetY + ratio * (end.targetY - start.targetY);
  }

  private getPdfSourcePageLayout(sourceWidth: number): Array<{ pageNumber: number; offsetY: number; width: number; height: number }> {
    const pages: Array<{ pageNumber: number; offsetY: number; width: number; height: number }> = [];
    let offsetY = 0;

    for (const entry of this.pdfBackgroundPages) {
      const targetWidth = Math.max(1, Math.ceil(entry.viewport.width));
      const targetHeight = Math.max(1, Math.ceil(entry.viewport.height));
      const sourceHeight = Math.max(1, targetHeight * (sourceWidth / targetWidth));
      pages.push({
        pageNumber: entry.pageNumber,
        offsetY,
        width: sourceWidth,
        height: sourceHeight
      });
      offsetY += sourceHeight + (entry.pageNumber === this.pdfBackgroundPages.length ? 0 : PDF_BACKGROUND_PAGE_GAP);
    }

    return pages;
  }

  private findPdfSourcePageForStroke(
    stroke: InkStroke,
    sourcePages: Array<{ pageNumber: number; offsetY: number; width: number; height: number }>,
    sourceHeight: number
  ): { pageNumber: number; offsetY: number; width: number; height: number } | null {
    const bounds = this.getStrokesBounds([stroke]);
    const y = bounds ? bounds.y + bounds.height / 2 : stroke.points[0]?.y ?? 0;
    let nearest: { pageNumber: number; offsetY: number; width: number; height: number } | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const page of sourcePages) {
      if (y >= page.offsetY && y <= page.offsetY + page.height) {
        return page;
      }

      const distance = y < page.offsetY
        ? page.offsetY - y
        : y - (page.offsetY + page.height);
      if (distance < nearestDistance) {
        nearest = page;
        nearestDistance = distance;
      }
    }

    if (!nearest && sourcePages.length > 0 && sourceHeight > 0) {
      return y <= sourceHeight / 2 ? sourcePages[0] : sourcePages[sourcePages.length - 1];
    }
    return nearest;
  }

  

  

  private getMarkdownAnnotationDisplayRect(annotation: PdfTextAnnotation, rect: PageRect): PageRect {
    const sourceWidth = Number.isFinite(annotation.pageWidth) && annotation.pageWidth && annotation.pageWidth > 0
      ? annotation.pageWidth
      : this.pageLogicalWidth;
    const sourceHeight = Number.isFinite(annotation.pageHeight) && annotation.pageHeight && annotation.pageHeight > 0
      ? annotation.pageHeight
      : this.pageLogicalHeight;
    const scaleX = this.pageLogicalWidth / Math.max(1, sourceWidth);
    const scaleY = this.pageLogicalHeight / Math.max(1, sourceHeight);

    return {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    };
  }

  

  private bindMarkdownAnnotationMenuTarget(
    element: HTMLElement,
    annotation: PdfTextAnnotation,
    rect: PageRect
  ): void {
    const open = (event: MouseEvent | PointerEvent) => {
      if (!this.selectMode) return;

      event.preventDefault();
      event.stopPropagation();
      this.showPdfAnnotationMenu(annotation.id, {
        x: rect.x + Math.min(rect.width, 96),
        y: Math.max(0, rect.y - 42)
      });
    };

    element.addEventListener("pointerdown", (event) => {
      if (!this.selectMode) return;
      event.preventDefault();
      event.stopPropagation();
    });
    element.addEventListener("click", open);
    element.addEventListener("contextmenu", open);
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  private findChangedTouchById(event: TouchEvent, identifier: number): Touch | null {
    for (let index = 0; index < event.changedTouches.length; index++) {
      const touch = event.changedTouches.item(index);
      if (touch?.identifier === identifier) return touch;
    }

    return null;
  }

  private getPdfEntryFromTextLayer(textLayer: HTMLElement): PdfBackgroundPageEntry | null {
    return this.pdfBackgroundPages.find((entry) => entry.textLayer === textLayer) ?? null;
  }

  private getPdfEntryFromPointerEvent(event: PointerEvent): PdfBackgroundPageEntry | null {
    const target = event.target instanceof Element ? event.target : null;
    return this.getPdfEntryFromClientPoint(event.clientX, event.clientY, target);
  }

  private getPdfEntryFromClientPoint(clientX: number, clientY: number, target: Element | null): PdfBackgroundPageEntry | null {
    const textLayer = target?.closest(".mobile-ink-pdf-text-layer");
    if (textLayer instanceof HTMLElement) {
      const entry = this.getPdfEntryFromTextLayer(textLayer);
      if (entry) return entry;
    }

    const pageEl = target?.closest(".mobile-ink-pdf-page-background");
    if (pageEl instanceof HTMLElement) {
      const pageNumber = Number.parseInt(pageEl.dataset.mobileInkPdfPage ?? "", 10);
      const entry = Number.isFinite(pageNumber)
        ? this.pdfBackgroundPages.find((page) => page.pageNumber === pageNumber)
        : null;
      if (entry) return entry;
    }

    return this.pdfBackgroundPages.find((entry) => {
      const rect = entry.pageEl.getBoundingClientRect();
      return clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom;
    }) ?? null;
  }

  private pdfPointerEventToPagePoint(event: PointerEvent, entry: PdfBackgroundPageEntry): PagePoint | null {
    return this.clientToPdfPagePoint(event.clientX, event.clientY, entry);
  }

  private clientToPdfPagePoint(clientX: number, clientY: number, entry: PdfBackgroundPageEntry): PagePoint | null {
    const rect = entry.pageEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const scaleX = Math.max(1, Math.ceil(entry.viewport.width)) / rect.width;
    const scaleY = Math.max(1, Math.ceil(entry.viewport.height)) / rect.height;
    return {
      x: Math.min(Math.max((clientX - rect.left) * scaleX, 0), Math.max(1, Math.ceil(entry.viewport.width))),
      y: Math.min(Math.max((clientY - rect.top) * scaleY, 0), Math.max(1, Math.ceil(entry.viewport.height)))
    };
  }

  

  

  

  

  private shouldUseVisualPdfSelectionFallback(selectionRect: PageRect, rects: PdfTextSelectionRect[], text: string): boolean {
    if (rects.length === 0) return true;
    if (this.hasMeaningfulPdfText(text)) return false;

    let bounds: PageRect | null = null;
    for (const rect of rects) {
      bounds = bounds ? this.unionRects(bounds, rect) : { ...rect };
    }
    if (!bounds) return true;

    const selectionArea = Math.max(1, selectionRect.width * selectionRect.height);
    const extractedArea = Math.max(1, bounds.width * bounds.height);
    return selectionRect.width >= 48
      && selectionRect.height >= 12
      && extractedArea / selectionArea < 0.45;
  }

  

  

  

  

  

  

  

  

  

  

  

  private buildPdfSelectedText(items: PdfTextLayerItem[]): string {
    let text = "";
    let previous: PdfTextLayerItem | null = null;

    for (const item of items) {
      if (previous) {
        const newLine = Math.abs(item.y - previous.y) > Math.max(4, Math.min(item.height, previous.height) * 0.7);
        if (newLine) {
          text += "\n";
        } else if (this.shouldInsertPdfTextSpace(previous, item)) {
          text += " ";
        }
      }

      text += item.text;
      if (item.hasEOL) {
        text += "\n";
      }
      previous = item;
    }

    return text.replace(/[ \t]+\n/g, "\n").trim();
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  private buildMarkdownSelectedText(items: MarkdownTextLayerItem[]): string {
    let text = "";
    let previous: MarkdownTextLayerItem | null = null;

    for (const item of items) {
      if (previous) {
        const newLine = previous.hasEOL
          || Math.abs(item.y - previous.y) > Math.max(4, Math.min(item.height, previous.height) * 0.7);
        if (newLine && !text.endsWith("\n")) {
          text += "\n";
        }
      }
      text += item.text;
      previous = item;
    }

    return text.replace(/[ \t]+\n/g, "\n");
  }

  

  private getTextMenuPosition(preferredPoint: PagePoint, menuWidth: number, menuHeight: number): PagePoint {
    const margin = 8;
    const selectionBounds = this.getCurrentTextSelectionBounds();
    const maxLeft = Math.max(margin, this.pageLogicalWidth - menuWidth - margin);
    const maxTop = Math.max(margin, this.pageLogicalHeight - menuHeight - margin);

    if (!selectionBounds) {
      return {
        x: Math.min(Math.max(preferredPoint.x, margin), maxLeft),
        y: Math.min(Math.max(preferredPoint.y, margin), maxTop)
      };
    }

    const centerX = selectionBounds.x + selectionBounds.width / 2;
    const aboveTop = selectionBounds.y - menuHeight - margin;
    const belowTop = selectionBounds.y + selectionBounds.height + margin;
    let left = centerX - menuWidth / 2;
    let top = aboveTop >= margin ? aboveTop : belowTop;

    if (top > maxTop && aboveTop >= margin) {
      top = aboveTop;
    }

    if (top > maxTop && belowTop > maxTop) {
      const rightLeft = selectionBounds.x + selectionBounds.width + margin;
      const leftLeft = selectionBounds.x - menuWidth - margin;
      if (rightLeft <= maxLeft) {
        left = rightLeft;
        top = selectionBounds.y;
      } else if (leftLeft >= margin) {
        left = leftLeft;
        top = selectionBounds.y;
      }
    }

    return {
      x: Math.min(Math.max(left, margin), maxLeft),
      y: Math.min(Math.max(top, margin), maxTop)
    };
  }

  private getCurrentTextSelectionBounds(): PageRect | null {
    const selection = this.pdfTextSelection;
    if (!selection || selection.rects.length === 0) return null;

    let bounds: PageRect | null = null;
    for (const rect of selection.rects) {
      const absoluteRect: PageRect = {
        x: rect.x,
        y: (this.isPdfPath(this.sourcePath) ? this.getPdfPageOffsetY(rect.pageNumber) : 0) + rect.y,
        width: rect.width,
        height: rect.height
      };
      bounds = bounds ? this.unionRects(bounds, absoluteRect) : absoluteRect;
    }

    return bounds;
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  private async copyPdfSelectedText(): Promise<void> {
    const text = this.pdfTextSelection?.text || document.getSelection()?.toString().trim() || "";
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      new Notice("PDFの文字をコピーしました。");
    } catch {
      new Notice("コピーできませんでした。端末のコピーメニューを使ってください。");
    } finally {
      this.hidePdfTextMenu();
    }
  }

  

  

  

  private getPdfPageOffsetY(pageNumber: number): number {
    return this.pdfBackgroundPages.find((entry) => entry.pageNumber === pageNumber)?.offsetY ?? 0;
  }

  

  private isNodeInsideMarkdownBackground(node: Node | null): boolean {
    if (!node) return false;
    const element = node instanceof Element ? node : node.parentElement;
    return !!element?.closest(".mobile-ink-background");
  }

  private getPdfBackgroundOutputScale(width: number, height: number, quality: Exclude<PdfRenderQuality, "none">): number {
    const mobile = this.isMobileLike();
    const dprCap = mobile
      ? quality === "sharp"
        ? this.isLongMobilePdf()
          ? PDF_BACKGROUND_MOBILE_LONG_DOC_SHARP_DPR
          : PDF_BACKGROUND_MOBILE_SHARP_DPR
        : PDF_BACKGROUND_MOBILE_PREVIEW_DPR
      : quality === "sharp" ? PDF_BACKGROUND_DESKTOP_SHARP_DPR : PDF_BACKGROUND_DESKTOP_PREVIEW_DPR;
    const pixelCap = mobile
      ? quality === "sharp"
        ? this.isLongMobilePdf()
          ? 3_600_000
          : 5_200_000
        : 1_200_000
      : quality === "sharp" ? 8_000_000 : 3_000_000;
    const baseScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), dprCap);
    const maxByPixels = Math.sqrt(pixelCap / Math.max(1, width * height));
    return Math.min(baseScale, maxByPixels);
  }

  private isMobileLike(): boolean {
    return isMobileInkEnvironment();
  }

  private yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  private getDefaultMarkdownPageSize(scroll: HTMLElement): { width: number; height: number } {
    const availableWidth = Math.max(320, scroll.clientWidth - 24);
    const width = Math.min(Math.max(availableWidth, 320), 960);
    const height = Math.max(scroll.clientHeight - 24, 480);
    return { width, height };
  }

  private async measureAndFreezePage(scroll: HTMLElement, page: HTMLElement, background: HTMLElement, preferredWidth?: number, preferredHeight?: number): Promise<{ width: number; height: number }> {
    const defaultSize = this.getDefaultMarkdownPageSize(scroll);
    const pageWidth = Number.isFinite(preferredWidth) && preferredWidth && preferredWidth > 0
      ? Math.max(320, Math.min(Math.ceil(preferredWidth), 1600))
      : defaultSize.width;

    page.style.width = `${pageWidth}px`;
    background.style.width = `${pageWidth}px`;

    await nextFrame();

    const minHeight = Math.max(
      defaultSize.height,
      Number.isFinite(preferredHeight) && preferredHeight && preferredHeight > 0
        ? Math.ceil(preferredHeight)
        : 0
    );
    const pageHeight = Math.max(
      minHeight,
      background.scrollHeight + 24,
      background.getBoundingClientRect().height + 24
    );

    this.freezePageSize(page, background, pageWidth, pageHeight);

    return { width: pageWidth, height: pageHeight };
  }

  private freezePageSize(page: HTMLElement, background: HTMLElement, width: number, height: number): void {
    this.pageLogicalWidth = width;
    this.pageLogicalHeight = height;
    page.style.width = `${width}px`;
    page.style.height = `${height}px`;
    background.style.width = `${width}px`;
    background.style.height = `${height}px`;
    this.applyZoom();
  }

  private async waitForStableMarkdownLayout(background: HTMLElement): Promise<void> {
    let lastWidth = -1;
    let lastHeight = -1;
    let stableFrames = 0;

    for (let frame = 0; frame < 8; frame++) {
      await nextFrame();
      const rect = background.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(Math.max(background.scrollHeight, rect.height));

      if (Math.abs(width - lastWidth) <= 1 && Math.abs(height - lastHeight) <= 1) {
        stableFrames++;
        if (stableFrames >= 2) return;
      } else {
        stableFrames = 0;
        lastWidth = width;
        lastHeight = height;
      }
    }
  }

  private collectMarkdownLayoutSnapshot(): MarkdownLayoutSnapshot | undefined {
    if (!this.backgroundEl || !this.pageEl || this.standalone || this.isPdfPath(this.sourcePath)) {
      return undefined;
    }

    const pageRect = this.pageEl.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return undefined;

    const scaleY = this.pageLogicalHeight / Math.max(1, pageRect.height);
    const anchors: MarkdownLayoutSnapshot["anchors"] = [];
    const occurrences = new Map<string, number>();
    const candidates = Array.from(this.backgroundEl.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,img,.callout,.markdown-embed,.internal-embed,.media-embed,.math-block,.katex-display,mjx-container[display='true']"
    ));

    for (const element of candidates) {
      if (this.shouldSkipMarkdownLayoutAnchor(element)) continue;

      const rect = element.getBoundingClientRect();
      const height = rect.height * scaleY;
      if (height < 2 || rect.width < 2) continue;

      const signature = this.getMarkdownLayoutAnchorSignature(element);
      if (!signature) continue;

      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      const y = (rect.top - pageRect.top) * scaleY;

      anchors.push({
        key: `${signature}:${occurrence}`,
        y: Math.round(y * 100) / 100,
        height: Math.round(height * 100) / 100
      });
    }

    if (anchors.length === 0) return undefined;

    return {
      version: 1,
      sourceHash: this.currentMarkdownSourceHash ?? undefined,
      pageWidth: Math.max(1, Math.ceil(this.pageLogicalWidth)),
      pageHeight: Math.max(1, Math.ceil(this.pageLogicalHeight)),
      anchors
    };
  }

  private shouldSkipMarkdownLayoutAnchor(element: HTMLElement): boolean {
    if (element.closest("mjx-assistive-mml, script, style")) return true;
    if (element.matches("p") && element.closest("li, blockquote, .callout, .markdown-embed, .internal-embed")) return true;
    if (element.matches("li") && element.closest("li li")) return false;

    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  }

  private getMarkdownLayoutAnchorSignature(element: HTMLElement): string | null {
    const tag = element.tagName.toLowerCase();
    const imageSource = element instanceof HTMLImageElement
      ? element.currentSrc || element.src || element.getAttribute("src") || ""
      : "";
    const rawText = imageSource || element.textContent || element.getAttribute("src") || element.getAttribute("alt") || tag;
    const text = rawText.replace(/\s+/g, " ").trim();
    const normalized = text.length > 0 ? text.slice(0, 240) : tag;
    if (!normalized) return null;

    return `${tag}:${stableHash(normalized)}`;
  }

  private setToolbarCollapsed(collapsed: boolean): void {
    const center = this.getToolbarCenter();
    this.toolbarCollapsed = collapsed;
    if (collapsed) {
      this.setPaletteOpen(false);
      this.setWidthPanelOpen(false);
      this.setEraserPanelOpen(false);
      this.setMorePanelOpen(false);
    }
    this.toolbarEl?.classList.toggle("mobile-ink-toolbar-collapsed", collapsed);
    if (center) {
      this.positionToolbarAroundCenter(center);
    } else if (this.toolbarPosition) {
      requestAnimationFrame(() => {
        if (!this.toolbarPosition) return;
        this.setToolbarPosition(this.toolbarPosition.left, this.toolbarPosition.top);
      });
    }
  }

  private setBrowseMode(enabled: boolean): void {
    this.browseMode = enabled;

    if (enabled) {
      this.setPaletteOpen(false);
      this.setWidthPanelOpen(false);
      this.setEraserPanelOpen(false);
      this.setMorePanelOpen(false);
      this.selectMode = false;
      this.strokeSelectMode = false;
      this.captureMode = false;
      this.rootEl?.classList.remove("mobile-ink-select-mode", "mobile-ink-stroke-select-mode", "mobile-ink-capture-mode");
      this.clearPdfTextSelectionUi();
      this.clearPdfTextLayers();
    }

    this.rootEl?.classList.toggle("mobile-ink-browse-mode", enabled);
    this.syncInkInputEnabled();
    this.refreshToolbarState();
  }

  private leaveBrowseMode(): void {
    if (!this.browseMode) return;

    this.browseMode = false;
    this.rootEl?.classList.remove("mobile-ink-browse-mode");
  }

  private syncInkInputEnabled(): void {
    this.engine?.setInputEnabled(!this.browseMode && !this.selectMode && !this.strokeSelectMode && !this.captureMode);
  }

  private setSelectMode(enabled: boolean): void {
    if (enabled && this.strokeSelectMode) {
      ((...args: any[]) => (null as any))(false);
    }
    if (enabled && this.captureMode) {
      ((...args: any[]) => (null as any))(false);
    }

    this.selectMode = enabled;
    if (enabled) {
      this.leaveBrowseMode();
    } else {
      this.browseMode = true;
    }
    if (enabled) {
      this.setPaletteOpen(false);
      this.setWidthPanelOpen(false);
      this.setEraserPanelOpen(false);
      this.setMorePanelOpen(false);
      if (this.isPdfPath(this.sourcePath)) {
        this.queueCurrentPdfTextLayersRender();
        this.queueVisiblePdfTextLayersRender();
      }
    } else {
      this.cancelPdfTextSelectionRefresh();
      this.clearPdfTextSelectionUi();
      this.clearPdfTextLayers();
    }

    this.rootEl?.classList.toggle("mobile-ink-select-mode", enabled);
    this.rootEl?.classList.toggle("mobile-ink-browse-mode", this.browseMode);
    this.syncInkInputEnabled();
    this.refreshToolbarState();
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  private getImageTimestamp(): string {
    const date = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  private getPasteOffset(strokes: InkStroke[]): PagePoint {
    const bounds = this.getStrokesBounds(strokes);
    const baseOffset = 24 * (this.pasteSequence + 1);
    if (!bounds) {
      return { x: baseOffset, y: baseOffset };
    }

    let dx = baseOffset;
    let dy = baseOffset;
    if (bounds.x + bounds.width + dx > this.pageLogicalWidth) {
      dx = Math.max(12 - bounds.x, this.pageLogicalWidth - bounds.x - bounds.width - 12);
    }
    if (bounds.y + bounds.height + dy > this.pageLogicalHeight) {
      dy = Math.max(12 - bounds.y, this.pageLogicalHeight - bounds.y - bounds.height - 12);
    }

    return { x: dx, y: dy };
  }

  private setPaletteOpen(open: boolean): void {
    this.paletteOpen = open && !this.toolbarCollapsed;
    if (this.paletteOpen) {
      this.widthPanelOpen = false;
      this.eraserPanelOpen = false;
      this.morePanelOpen = false;
    }
    this.colorPaletteEl?.classList.toggle("mobile-ink-popover-open", this.paletteOpen);
    this.widthPanelEl?.classList.toggle("mobile-ink-popover-open", this.widthPanelOpen);
    this.eraserPanelEl?.classList.toggle("mobile-ink-popover-open", this.eraserPanelOpen);
    this.morePanelEl?.classList.toggle("mobile-ink-popover-open", this.morePanelOpen);
    this.setButtonActive(this.toolbarButtons.palette, this.paletteOpen);
    this.setButtonActive(this.toolbarButtons.width, this.widthPanelOpen);
    this.setButtonActive(this.toolbarButtons.more, this.morePanelOpen);
    this.toolbarButtons.palette?.setAttribute("aria-expanded", this.paletteOpen ? "true" : "false");
    this.updatePopoverPlacement();
  }

  private hasOpenToolbarPopover(): boolean {
    return this.paletteOpen || this.widthPanelOpen || this.eraserPanelOpen || this.morePanelOpen;
  }

  private closeToolbarPopovers(): void {
    if (!this.hasOpenToolbarPopover()) return;

    this.setPaletteOpen(false);
    this.setWidthPanelOpen(false);
    this.setEraserPanelOpen(false);
    this.setMorePanelOpen(false);
  }

  private setWidthPanelOpen(open: boolean): void {
    this.widthPanelOpen = open && !this.toolbarCollapsed;
    if (this.widthPanelOpen) {
      this.paletteOpen = false;
      this.eraserPanelOpen = false;
      this.morePanelOpen = false;
    }
    this.colorPaletteEl?.classList.toggle("mobile-ink-popover-open", this.paletteOpen);
    this.widthPanelEl?.classList.toggle("mobile-ink-popover-open", this.widthPanelOpen);
    this.eraserPanelEl?.classList.toggle("mobile-ink-popover-open", this.eraserPanelOpen);
    this.morePanelEl?.classList.toggle("mobile-ink-popover-open", this.morePanelOpen);
    this.setButtonActive(this.toolbarButtons.palette, this.paletteOpen);
    this.setButtonActive(this.toolbarButtons.width, this.widthPanelOpen);
    this.setButtonActive(this.toolbarButtons.more, this.morePanelOpen);
    this.toolbarButtons.width?.setAttribute("aria-expanded", this.widthPanelOpen ? "true" : "false");
    this.updatePopoverPlacement();
  }

  private setEraserPanelOpen(open: boolean): void {
    this.eraserPanelOpen = open && !this.toolbarCollapsed;
    if (this.eraserPanelOpen) {
      this.paletteOpen = false;
      this.widthPanelOpen = false;
      this.morePanelOpen = false;
    }
    this.colorPaletteEl?.classList.toggle("mobile-ink-popover-open", this.paletteOpen);
    this.widthPanelEl?.classList.toggle("mobile-ink-popover-open", this.widthPanelOpen);
    this.eraserPanelEl?.classList.toggle("mobile-ink-popover-open", this.eraserPanelOpen);
    this.morePanelEl?.classList.toggle("mobile-ink-popover-open", this.morePanelOpen);
    this.setButtonActive(this.toolbarButtons.palette, this.paletteOpen);
    this.setButtonActive(this.toolbarButtons.width, this.widthPanelOpen);
    this.setButtonActive(this.toolbarButtons.more, this.morePanelOpen);
    this.toolbarButtons.zoomOut?.toggleAttribute("disabled", this.zoom <= MIN_ZOOM + 0.001);
    this.toolbarButtons.zoomIn?.toggleAttribute("disabled", this.zoom >= MAX_ZOOM - 0.001);
    this.toolbarButtons.zoomReset?.classList.toggle("mobile-ink-active", Math.abs(this.zoom - 1) > 0.001);
    this.updatePopoverPlacement();
  }

  private setMorePanelOpen(open: boolean): void {
    this.morePanelOpen = open && !this.toolbarCollapsed;
    if (this.morePanelOpen) {
      this.paletteOpen = false;
      this.widthPanelOpen = false;
      this.eraserPanelOpen = false;
    }
    this.colorPaletteEl?.classList.toggle("mobile-ink-popover-open", this.paletteOpen);
    this.widthPanelEl?.classList.toggle("mobile-ink-popover-open", this.widthPanelOpen);
    this.eraserPanelEl?.classList.toggle("mobile-ink-popover-open", this.eraserPanelOpen);
    this.morePanelEl?.classList.toggle("mobile-ink-popover-open", this.morePanelOpen);
    this.setButtonActive(this.toolbarButtons.palette, this.paletteOpen);
    this.setButtonActive(this.toolbarButtons.width, this.widthPanelOpen);
    this.setButtonActive(this.toolbarButtons.more, this.morePanelOpen);
    this.toolbarButtons.exportPdf?.toggleAttribute("disabled", this.exportingPdf);
    this.toolbarButtons.exportPdf?.setAttribute("aria-busy", String(this.exportingPdf));
    this.toolbarButtons.more?.setAttribute("aria-expanded", this.morePanelOpen ? "true" : "false");
    this.updatePopoverPlacement();
    this.refreshToolbarState();
  }

  private activateEraser():void {
    const state=this.engine?.getToolState();
    if(state?.tool==='eraser'){this.setTool(this.previousWritingTool);return;}
    if(state?.tool==='pen' || state?.tool==='highlighter')this.previousWritingTool=state.tool;
    if(this.selectMode)this.setSelectMode(false);
    this.leaveBrowseMode();this.syncInkInputEnabled();
    this.engine?.flushPendingStrokes();
    this.engine?.setToolState({tool:'eraser'});
    this.closeToolbarPopovers();this.refreshToolbarState();
  }

  private setTool(tool: VisibleInkTool, options: { allowToggleBrowse?: boolean } = {}): void {
    this.engine?.flushPendingStrokes();
    if(tool==='pen' || tool==='highlighter')this.previousWritingTool=tool;
    if (this.selectMode) {
      this.setSelectMode(false);
    }
    if (this.strokeSelectMode) {
      ((...args: any[]) => (null as any))(false);
    }
    if (this.captureMode) {
      ((...args: any[]) => (null as any))(false);
    }
    this.setEraserPanelOpen(false);
    this.setMorePanelOpen(false);
    this.leaveBrowseMode();
    this.syncInkInputEnabled();
    this.engine?.setToolState({ tool });
    this.refreshToolbarState();
  }

  private setInkColor(color: string): void {
    const state = this.engine?.getToolState();
    if (state?.tool === "highlighter") {
      this.engine?.setToolState({ highlighterColor: color });
    } else {
      this.engine?.setToolState({ color });
    }
    this.refreshToolbarState();
  }

  private setInkWidth(width: number): void {
    if (!Number.isFinite(width)) return;

    const normalized = Math.min(Math.max(width, 1), 36);
    const state = this.engine?.getToolState();
    if (state?.tool === "eraser") {
      this.engine?.setToolState({ eraserRadius: normalized });
    } else if (state?.tool === "highlighter") {
      this.engine?.setToolState({ highlighterWidth: normalized });
    } else {
      this.engine?.setToolState({ width: normalized });
    }
    this.refreshToolbarState();
  }

  

  private refreshToolbarState(): void {
    const state = this.engine?.getToolState();
    if (!state) return;
    this.toolbarButtons.undo?.toggleAttribute('disabled',!this.engine?.canUndo());
    this.toolbarButtons.redo?.toggleAttribute('disabled',!this.engine?.canRedo());
    this.toolbarButtons.exportPdf?.toggleAttribute('hidden',!this.isPdfPath(this.sourcePath));
    this.toolbarButtons.exit?.setAttribute('aria-label',this.isPdfPath(this.sourcePath) ? '元のPDFに戻る' : '元のファイルに戻る');

    this.setButtonActive(this.toolbarButtons.pen, !this.browseMode && !this.selectMode && !this.strokeSelectMode && !this.captureMode && state.tool === "pen");
    this.setButtonActive(this.toolbarButtons.highlighter, !this.browseMode && !this.selectMode && !this.strokeSelectMode && !this.captureMode && state.tool === "highlighter");
    this.setButtonActive(this.toolbarButtons.eraser, !this.browseMode && !this.selectMode && !this.strokeSelectMode && !this.captureMode && state.tool === "eraser");
    this.setButtonActive(this.toolbarButtons.strokeSelect, this.strokeSelectMode);
    this.setButtonActive(this.toolbarButtons.capture, this.captureMode);
    this.setButtonActive(this.toolbarButtons.select, this.selectMode);
    this.setButtonActive(this.toolbarButtons.touch, state.acceptTouchInput);
    ((...args: any[]) => (null as any))();

    const touchLabel = state.acceptTouchInput ? "指での手書きをオフ" : "指での手書きをオン";
    this.toolbarButtons.touch?.setAttribute("aria-label", touchLabel);
    this.toolbarButtons.touch?.setAttribute("title", touchLabel);

    const activeColor = this.getActiveColor(state);
    this.updateToolButtonColors(state);
    if (this.currentColorDot) {
      this.currentColorDot.style.backgroundColor = activeColor;
    }
    if (this.customColorInput && /^#[0-9a-f]{6}$/i.test(activeColor)) {
      this.customColorInput.value = activeColor;
    }
    for (const [color, button] of this.colorButtons) {
      this.setButtonActive(button, color === activeColor.toLowerCase());
    }

    const activeWidth = this.getActiveWidth(state);
    if (this.widthRangeInput) {
      this.widthRangeInput.value = String(activeWidth);
    }
    if (this.widthNumberInput) {
      this.widthNumberInput.value = String(activeWidth);
    }
    if (this.widthPreviewLine) {
      this.widthPreviewLine.style.height = `${Math.min(Math.max(activeWidth, 2), 30)}px`;
      this.widthPreviewLine.style.backgroundColor = activeColor;
    }

    this.toolbarEl?.classList.toggle("mobile-ink-toolbar-collapsed", this.toolbarCollapsed);
    this.rootEl?.classList.toggle("mobile-ink-browse-mode", this.browseMode);
    this.colorPaletteEl?.classList.toggle("mobile-ink-popover-open", this.paletteOpen && !this.toolbarCollapsed);
    this.widthPanelEl?.classList.toggle("mobile-ink-popover-open", this.widthPanelOpen && !this.toolbarCollapsed);
    this.eraserPanelEl?.classList.toggle("mobile-ink-popover-open", this.eraserPanelOpen && !this.toolbarCollapsed);
    this.morePanelEl?.classList.toggle("mobile-ink-popover-open", this.morePanelOpen && !this.toolbarCollapsed);
    this.setButtonActive(this.toolbarButtons.palette, this.paletteOpen);
    this.setButtonActive(this.toolbarButtons.width, this.widthPanelOpen);
    this.setButtonActive(this.toolbarButtons.more, this.morePanelOpen);
    this.toolbarButtons.exportPdf?.toggleAttribute("disabled", this.exportingPdf);
    this.toolbarButtons.exportPdf?.setAttribute("aria-busy", String(this.exportingPdf));
    this.toolbarButtons.more?.setAttribute("aria-expanded", this.morePanelOpen ? "true" : "false");
    this.toolbarButtons.zoomOut?.toggleAttribute("disabled", this.zoom <= MIN_ZOOM + 0.001);
    this.toolbarButtons.zoomIn?.toggleAttribute("disabled", this.zoom >= MAX_ZOOM - 0.001);
    this.toolbarButtons.zoomReset?.classList.toggle("mobile-ink-active", Math.abs(this.zoom - 1) > 0.001);
    this.updatePopoverPlacement();
  }

  private async confirmAndClearAll(): Promise<void> {
    if (!this.plugin.hasFeature("clearAllAnnotations")) {
      new Notice("この版では注釈の一括削除を利用できません。");
      return;
    }

    const confirmed = window.confirm("このファイルの手書きと注釈をすべて削除しますか？この操作は元に戻せません。");
    if (!confirmed) return;

    this.setEraserPanelOpen(false);
    this.setMorePanelOpen(false);
    this.pdfTextAnnotations = [];
    this.clearPdfTextSelectionUi();
    this.renderPdfTextAnnotations();
    this.engine?.clear();
    await this.saveQueue?.flush();
    new Notice("手書きと注釈をすべて削除しました。");
  }

  private getActiveColor(state = this.engine?.getToolState()): string {
    if (!state) return "#111111";
    if (state.tool === "eraser") return "rgba(76, 82, 90, 0.55)";
    return state.tool === "highlighter" ? state.highlighterColor : state.color;
  }

  private getActiveWidth(state = this.engine?.getToolState()): number {
    if (!state) return 2;
    if (state.tool === "eraser") return state.eraserRadius;
    return state.tool === "highlighter" ? state.highlighterWidth : state.width;
  }

  private updateToolButtonColors(state = this.engine?.getToolState()): void {
    if (!state) return;

    this.toolbarButtons.pen?.style.setProperty("--mobile-ink-tool-color", state.color);
    this.toolbarButtons.highlighter?.style.setProperty("--mobile-ink-tool-color", state.highlighterColor);
    this.toolbarButtons.eraser?.style.setProperty("--mobile-ink-tool-color", "rgba(96, 102, 112, 0.82)");
    this.toolbarButtons.expand?.style.setProperty("--mobile-ink-tool-color", this.getActiveColor(state));
  }

  private setButtonActive(button: HTMLElement | undefined, active: boolean): void {
    if (!button) return;
    button.classList.toggle("mobile-ink-active", active);
  }

  

  

  

  

  private getMarkdownExportHorizontalCrop(sourceWidth: number, strokes: InkStroke[]): { left: number; width: number } {
    let bounds: PageRect | null = this.getBackgroundContentBounds();
    const strokeBounds = this.getStrokesBounds(strokes);
    if (strokeBounds) {
      bounds = bounds ? this.unionRects(bounds, strokeBounds) : strokeBounds;
    }

    if (!bounds) {
      return { left: 0, width: sourceWidth };
    }

    // 只裁掉右侧空白，绝不从左侧裁切，避免 Markdown 缩进、表格或左侧标注被截掉。
    const padding = 48;
    const printableWidth = (PDF_A4_WIDTH_MM - PDF_A4_MARGIN_MM * 2) * CSS_PX_PER_MM;
    const minCropWidth = Math.min(sourceWidth, Math.ceil(printableWidth));
    const contentRight = Math.ceil(bounds.x + bounds.width + padding);
    const width = Math.min(sourceWidth, Math.max(minCropWidth, contentRight));

    return {
      left: 0,
      width: Math.max(1, width)
    };
  }

  private getBackgroundContentBounds(): PageRect | null {
    if (!this.backgroundEl) return null;

    let result: PageRect | null = null;
    const selector = [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "li", "table", "pre", "blockquote", "img",
      "mjx-container", ".MathJax", ".math", ".math-block", ".math-inline", ".block-language-math",
      ".katex", ".katex-display",
      ".callout", ".markdown-embed", ".internal-embed"
    ].join(",");

    for (const element of Array.from(this.backgroundEl.querySelectorAll(selector))) {
      const rect = this.getElementPageRect(element);
      if (!rect || rect.width < 1 || rect.height < 1) continue;

      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const right = Math.min(this.pageLogicalWidth, rect.x + rect.width);
      const bottom = Math.min(this.pageLogicalHeight, rect.y + rect.height);
      if (right <= x || bottom <= y) continue;

      const next = {
        x,
        y,
        width: right - x,
        height: bottom - y
      };
      result = result ? this.unionRects(result, next) : next;
    }

    return result;
  }

  private cloneBackgroundForExport(pageWidth: number, pageHeight: number): HTMLElement {
    if (!this.backgroundEl) {
      throw new Error("Background is not ready");
    }

    const clone = this.backgroundEl.cloneNode(true) as HTMLElement;
    clone.style.width = `${pageWidth}px`;
    clone.style.height = `${pageHeight}px`;
    clone.style.pointerEvents = "none";
    this.replaceExportCanvases(this.backgroundEl, clone);
    this.materializeExportMathSvgElements(this.backgroundEl, clone);
    this.materializeExportFormulaTextFallbacks(this.backgroundEl, clone);
    return clone;
  }

  private replaceExportCanvases(source: HTMLElement, clone: HTMLElement): void {
    const sourceCanvases = Array.from(source.querySelectorAll("canvas"));
    const clonedCanvases = Array.from(clone.querySelectorAll("canvas"));

    for (let i = 0; i < sourceCanvases.length; i++) {
      const sourceCanvas = sourceCanvases[i];
      const clonedCanvas = clonedCanvases[i];
      if (!clonedCanvas) continue;

      const image = document.createElement("img");
      image.className = clonedCanvas.className;
      image.setAttribute("style", clonedCanvas.getAttribute("style") ?? "");
      image.width = sourceCanvas.clientWidth || sourceCanvas.width;
      image.height = sourceCanvas.clientHeight || sourceCanvas.height;
      image.alt = "";

      try {
        image.src = sourceCanvas.toDataURL("image/png");
        clonedCanvas.replaceWith(image);
      } catch {
        clonedCanvas.remove();
      }
    }
  }

  private materializeExportMathSvgElements(source: HTMLElement, clone: HTMLElement): void {
    const sourceSvgs = this.getPdfMathSvgElementsFrom(source);
    const clonedSvgs = this.getPdfMathSvgElementsFrom(clone);

    for (let i = 0; i < sourceSvgs.length; i++) {
      const sourceSvg = sourceSvgs[i];
      const clonedSvg = clonedSvgs[i];
      if (!clonedSvg) continue;

      const rect = this.getElementPageRect(sourceSvg);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;

      const replacement = this.createExportMathInlineSvg(sourceSvg, rect);
      if (!replacement) continue;

      const computed = getComputedStyle(sourceSvg);
      const container = sourceSvg.closest("mjx-container, .MathJax, .math-block, .math-inline, .math, .block-language-math, .katex, .katex-display");
      const containerComputed = container ? getComputedStyle(container) : null;
      const isDisplayMath = container?.getAttribute("display") === "true"
        || containerComputed?.display === "block";

      replacement.classList.add("mobile-ink-export-math-svg");
      replacement.style.display = isDisplayMath ? "block" : "inline-block";
      replacement.style.width = `${Math.max(1, rect.width)}px`;
      replacement.style.height = `${Math.max(1, rect.height)}px`;
      replacement.style.maxWidth = "none";
      replacement.style.overflow = "visible";
      replacement.style.verticalAlign = computed.verticalAlign && computed.verticalAlign !== "baseline"
        ? computed.verticalAlign
        : "middle";

      clonedSvg.replaceWith(replacement);
    }
  }

  private createExportMathInlineSvg(sourceSvg: SVGSVGElement, rect: PageRect): SVGSVGElement | null {
    try {
      const markup = this.serializeMathSvgToMarkup(sourceSvg, rect);
      const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      const parsed = doc.documentElement;
      if (parsed.nodeName.toLowerCase() === "parsererror") {
        return null;
      }
      return document.importNode(parsed, true) as unknown as SVGSVGElement;
    } catch {
      return null;
    }
  }

  private materializeExportFormulaTextFallbacks(source: HTMLElement, clone: HTMLElement): void {
    const sourceFormulaElements = this.getPdfFormulaElementsFrom(source);
    const clonedFormulaElements = this.getPdfFormulaElementsFrom(clone);

    for (let i = 0; i < sourceFormulaElements.length; i++) {
      const sourceFormula = sourceFormulaElements[i];
      const clonedFormula = clonedFormulaElements[i] as HTMLElement | undefined;
      if (!clonedFormula) continue;

      // SVG 公式已经在 materializeExportMathSvgElements 中转成稳定图片；
      // 这里主要兜底 CHTML/移动端差异导致的空公式，避免桌面端打印时整块消失。
      if (this.getPdfMathSvgElementsFrom(sourceFormula).length > 0) continue;

      const rect = this.getElementPageRect(sourceFormula);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;

      const fallbackText = this.extractFormulaText(sourceFormula);
      if (!fallbackText) continue;

      const clonedText = (clonedFormula.textContent ?? "").replace(/\s+/g, " ").trim();
      const sourceText = (sourceFormula.textContent ?? "").replace(/\s+/g, " ").trim();
      if (clonedText && clonedText === sourceText) continue;

      clonedFormula.textContent = fallbackText;
      clonedFormula.classList.add("mobile-ink-export-formula-text");
      clonedFormula.style.display = sourceFormula.getAttribute("display") === "true" ? "block" : "inline-block";
      clonedFormula.style.minWidth = `${Math.max(1, Math.ceil(rect.width))}px`;
      clonedFormula.style.minHeight = `${Math.max(1, Math.ceil(rect.height))}px`;
      clonedFormula.style.whiteSpace = "pre-wrap";
      clonedFormula.style.fontFamily = "var(--font-monospace, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
      clonedFormula.style.fontSize = getComputedStyle(sourceFormula).fontSize || "14px";
      clonedFormula.style.color = getComputedStyle(sourceFormula).color || "currentColor";
    }
  }

  private getPdfFormulaElementsFrom(root: ParentNode): Element[] {
    const selector = [
      "mjx-container",
      ".MathJax",
      ".math",
      ".math-block",
      ".math-inline",
      ".block-language-math",
      ".katex-display",
      ".katex",
      "[data-math]",
      "[data-latex]"
    ].join(",");
    const elements: Element[] = [];
    const seen = new Set<Element>();

    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (seen.has(element)) continue;
      if (element.parentElement?.closest(selector)) continue;
      seen.add(element);
      elements.push(element);
    }

    return elements;
  }

  private buildStrokesSvg(strokes: InkStroke[], width: number, height: number): string {
    const elements = strokes.map((stroke: any) => this.strokeToSvgElement(stroke)).join("\n");
    return `<svg class="mobile-ink-pdf-strokes" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${elements}</svg>`;
  }

  private strokeToSvgElement(stroke: InkStroke): string {
    const points = stroke.points;
    if (points.length === 0) return "";

    const color = this.escapeAttribute(stroke.color);
    const width = ((...args: any[]) => (null as any))(stroke.width);
    const opacity = stroke.tool === "highlighter" ? "0.32" : "1";

    if (points.length === 1) {
      const point = points[0];
      const radius = ((...args: any[]) => (null as any))(stroke.width / 2);
      return `<circle cx="${((...args: any[]) => (null as any))(point.x)}" cy="${((...args: any[]) => (null as any))(point.y)}" r="${radius}" fill="${color}" opacity="${opacity}"/>`;
    }

    const path = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${((...args: any[]) => (null as any))(point.x)} ${((...args: any[]) => (null as any))(point.y)}`)
      .join(" ");

    return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
  }

  

  private formatCssInches(cssPixels: number): string {
    return ((...args: any[]) => (null as any))(Math.max(1, cssPixels) / 96);
  }

  

  

  private async renderSelectablePdfWithElectron(): Promise<ArrayBuffer> {
    const attempts: Array<{ includeDocumentStyles: boolean; label: string }> = [
      { includeDocumentStyles: true, label: "full document styles" },
      { includeDocumentStyles: false, label: "safe export styles" }
    ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        const html = ((...args: any[]) => (null as any))(attempt.includeDocumentStyles);
        const pdf = await ((...args: any[]) => (null as any))(html);
        if (pdf.byteLength < 4096) {
          throw new Error(`Selectable PDF export appears blank (${pdf.byteLength} bytes)`);
        }
        return pdf;
      } catch (error) {
        lastError = error;
        console.warn(`Note Ink: selectable PDF attempt failed (${attempt.label})`, error);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Selectable PDF export failed");
  }

  private async renderSelectableHybridPdfWithElectron(): Promise<ArrayBuffer> {
    if (!this.backgroundEl || !this.engine) {
      throw new Error("Selectable PDF export target is not ready");
    }

    try {
      await waitForImages(this.backgroundEl);
    } catch {
      // 图片加载失败时仍继续导出可选中文字层和当前可见内容。
    }

    const strokes = this.engine.getStrokes();
    const sourceWidth = Math.max(1, Math.ceil(this.pageLogicalWidth));
    const sourceHeight = Math.max(1, Math.ceil(((...args: any[]) => (null as any))(strokes)));
    const layout = ((...args: any[]) => (null as any))(sourceWidth, sourceHeight);
    const pageContentHeight = this.standalone ? layout.renderedHeight : layout.pageContentHeight;
    const slices = this.standalone
      ? [{ top: 0, height: Math.max(1, Math.ceil(layout.renderedHeight)) }]
      : this.getSafeBrowserPdfSlices(layout, pageContentHeight);

    const images: SelectablePdfPageImage[] = [];
    for (const slice of slices) {
      const sliceTop = slice.top;
      const sliceHeight = Math.max(1, slice.height);
      let jpeg: { bytes: Uint8Array; width: number; height: number };

      try {
        jpeg = await ((...args: any[]) => (null as any))(layout, strokes, sliceTop, sliceHeight, true, "svg");
      } catch (error) {
        console.warn("Note Ink: selectable PDF visible layer was unsafe; retrying without embedded images", error);
        try {
          jpeg = await ((...args: any[]) => (null as any))(layout, strokes, sliceTop, sliceHeight, false, "svg");
        } catch (formulaOrImageError) {
          console.warn("Note Ink: selectable PDF formula rendering failed; retrying with formula text fallback", formulaOrImageError);
          jpeg = await ((...args: any[]) => (null as any))(layout, strokes, sliceTop, sliceHeight, false, "text");
        }
      }

      images.push({
        dataUrl: this.bytesToDataUrl(jpeg.bytes, "image/jpeg"),
        cssWidth: Math.max(1, Math.ceil(layout.renderedWidth)),
        cssHeight: sliceHeight,
        sliceTop,
        sliceHeight
      });
    }

    const textLayerBackground = this.cloneBackgroundForExport(sourceWidth, sourceHeight);
    const html = this.buildSelectableHybridPdfHtml(layout, images, textLayerBackground.outerHTML);
    const pdf = await ((...args: any[]) => (null as any))(html);
    if (pdf.byteLength < 4096) {
      throw new Error(`Selectable hybrid PDF export appears blank (${pdf.byteLength} bytes)`);
    }
    return pdf;
  }

  private buildSelectableHybridPdfHtml(
    layout: PdfExportLayout,
    images: SelectablePdfPageImage[],
    textLayerBackgroundHtml: string
  ): string {
    const documentStyles = ((...args: any[]) => (null as any))();
    const cssVariables = ((...args: any[]) => (null as any))();
    const title = this.escapeHtml(((...args: any[]) => (null as any))());
    const htmlClass = this.escapeAttribute(document.documentElement.className);
    const bodyClass = this.escapeAttribute(document.body.className);
    const pageWidth = Math.max(1, Math.ceil(layout.renderedWidth));
    const sourceWidth = Math.max(1, Math.ceil(layout.sourceWidth));
    const sourceHeight = Math.max(1, Math.ceil(layout.sourceHeight));
    const scaledContentLeft = -layout.cropLeft * layout.scale;

    const pages = images.map((image, index) => {
      const pageBreak = index === images.length - 1 ? "auto" : "always";
      const scaledContentTop = -image.sliceTop;
      return `<section class="mobile-ink-pdf-page mobile-ink-selectable-pdf-page" style="width:${pageWidth}px;height:${image.cssHeight}px;break-after:${pageBreak};page-break-after:${pageBreak};">
<img class="mobile-ink-selectable-pdf-image" src="${image.dataUrl}" alt="" draggable="false" style="width:${pageWidth}px;height:${image.cssHeight}px;" />
<div class="mobile-ink-selectable-text-layer" aria-hidden="false">
<div class="mobile-ink-selectable-text-scaled-content" style="left:${((...args: any[]) => (null as any))(scaledContentLeft)}px;top:${((...args: any[]) => (null as any))(scaledContentTop)}px;width:${sourceWidth}px;height:${sourceHeight}px;transform:scale(${((...args: any[]) => (null as any))(layout.scale)});">
${textLayerBackgroundHtml}
</div>
</div>
</section>`;
    }).join("\n");

    return `<!doctype html>
<html class="${htmlClass}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${documentStyles}
${cssVariables}
@page {
  ${layout.pageRule}
}
html,
body {
  ${layout.bodyRule}
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: var(--text-normal, #1f2328);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.mobile-ink-selectable-pdf-page {
  position: relative;
  overflow: hidden;
  margin: 0 auto;
  background: #ffffff;
  contain: layout paint size;
}
.mobile-ink-selectable-pdf-image {
  display: block;
  position: absolute;
  inset: 0 auto auto 0;
  object-fit: fill;
  user-select: none;
  pointer-events: none;
  z-index: 1;
}
.mobile-ink-selectable-text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  z-index: 3;
  user-select: text;
  -webkit-user-select: text;
  pointer-events: auto;
}
.mobile-ink-selectable-text-scaled-content {
  position: absolute;
  transform-origin: 0 0;
  overflow: visible;
  user-select: text;
  -webkit-user-select: text;
}
.mobile-ink-selectable-text-layer .mobile-ink-background {
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  right: auto !important;
  bottom: auto !important;
  inset: auto !important;
  box-sizing: border-box;
  width: ${sourceWidth}px !important;
  min-width: ${sourceWidth}px !important;
  max-width: none !important;
  height: ${sourceHeight}px !important;
  min-height: ${sourceHeight}px !important;
  margin: 0 !important;
  overflow: visible !important;
  color: rgba(0, 0, 0, 0.012) !important;
  -webkit-text-fill-color: rgba(0, 0, 0, 0.012) !important;
  text-decoration-color: rgba(0, 0, 0, 0.012) !important;
  background: transparent !important;
  box-shadow: none !important;
}
.mobile-ink-selectable-text-layer .markdown-preview-view,
.mobile-ink-selectable-text-layer .markdown-preview-sizer {
  min-height: auto !important;
  margin: 0 !important;
}
.mobile-ink-selectable-text-layer img,
.mobile-ink-selectable-text-layer canvas,
.mobile-ink-selectable-text-layer video,
.mobile-ink-selectable-text-layer iframe {
  visibility: hidden !important;
}
.mobile-ink-selectable-text-layer svg {
  visibility: hidden !important;
}
.mobile-ink-selectable-text-layer mjx-assistive-mml {
  display: none !important;
}
.mobile-ink-selectable-text-layer * {
  user-select: text !important;
  -webkit-user-select: text !important;
  color: rgba(0, 0, 0, 0.012) !important;
  -webkit-text-fill-color: rgba(0, 0, 0, 0.012) !important;
  text-decoration-color: rgba(0, 0, 0, 0.012) !important;
  text-shadow: none !important;
  background: transparent !important;
  box-shadow: none !important;
  border-color: transparent !important;
  outline-color: transparent !important;
}
.mobile-ink-selectable-text-layer .mobile-ink-export-math-image,
.mobile-ink-selectable-text-layer .mobile-ink-export-math-svg {
  visibility: hidden !important;
}
.mobile-ink-selectable-text-layer .mobile-ink-export-formula-text {
  visibility: visible !important;
  display: inline-block !important;
  color: rgba(0, 0, 0, 0.012) !important;
  -webkit-text-fill-color: rgba(0, 0, 0, 0.012) !important;
  text-decoration-color: rgba(0, 0, 0, 0.012) !important;
  background: transparent !important;
  border: 0 !important;
  white-space: pre-wrap !important;
}
</style>
</head>
<body class="${bodyClass}">
${pages}
</body>
</html>`;
  }

  private renderSelectableTextLayerForPage(
    layout: PdfExportLayout,
    page: SelectablePdfPageImage,
    textSpans: SelectablePdfTextSpan[]
  ): string {
    const pageTop = page.sliceTop;
    const pageBottom = page.sliceTop + page.sliceHeight;
    const cropLeft = layout.cropLeft;
    const cropRight = layout.cropLeft + layout.cropWidth;
    const scale = layout.scale;
    const result: string[] = [];

    for (const span of textSpans) {
      const scaledLeft = (span.x - cropLeft) * scale;
      const scaledTop = span.y * scale;
      const scaledWidth = span.width * scale;
      const scaledHeight = span.height * scale;
      const scaledRight = scaledLeft + scaledWidth;
      const scaledBottom = scaledTop + scaledHeight;

      if (span.x + span.width < cropLeft || span.x > cropRight) continue;
      if (scaledBottom < pageTop || scaledTop > pageBottom) continue;

      const left = Math.max(-4, scaledLeft);
      const top = scaledTop - pageTop;
      const width = Math.max(1, Math.min(page.cssWidth + 8, scaledWidth));
      const height = Math.max(1, scaledHeight);
      if (left > page.cssWidth + 4 || top > page.cssHeight + 4 || top + height < -4 || scaledRight < -4) continue;

      const fontSize = Math.max(1, span.fontSize * scale);
      const lineHeight = Math.max(fontSize, span.lineHeight * scale);
      const style = [
        `left:${((...args: any[]) => (null as any))(left)}px`,
        `top:${((...args: any[]) => (null as any))(top)}px`,
        `width:${((...args: any[]) => (null as any))(width)}px`,
        `height:${((...args: any[]) => (null as any))(height)}px`,
        `font-family:${this.escapeAttribute(span.fontFamily || "sans-serif")}`,
        `font-size:${((...args: any[]) => (null as any))(fontSize)}px`,
        `font-weight:${this.escapeAttribute(span.fontWeight || "normal")}`,
        `font-style:${this.escapeAttribute(span.fontStyle || "normal")}`,
        `line-height:${((...args: any[]) => (null as any))(lineHeight)}px`,
        `letter-spacing:${this.escapeAttribute(span.letterSpacing || "normal")}`,
        `white-space:${this.escapeAttribute(span.whiteSpace || "pre-wrap")}`
      ].join(";");

      result.push(`<span style="${style}">${this.escapeHtml(span.text)}</span>`);
    }

    return result.join("\n");
  }

  

  

  private createTextRange(textNode: Text, start: number, end: number): Range | null {
    try {
      const range = document.createRange();
      range.setStart(textNode, Math.max(0, Math.min(start, textNode.length)));
      range.setEnd(textNode, Math.max(0, Math.min(end, textNode.length)));
      return range;
    } catch {
      return null;
    }
  }

  private getTextRangeVisibleClientRectCount(textNode: Text, start: number, end: number): number {
    const range = this.createTextRange(textNode, start, end);
    if (!range) return 0;
    try {
      return Array.from(range.getClientRects()).filter((rect: any) => rect.width > 0.2 && rect.height > 0.2).length;
    } finally {
      range.detach?.();
    }
  }

  

  

  private parseCssPixelValue(value: string, fallback: number): number {
    const parsed = Number.parseFloat(value || "");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async renderPdfWithBrowser(html: string): Promise<ArrayBuffer> {
    // 移动端没有 Electron/Chromium 的 printToPDF 能力。
    // 不再使用 foreignObject 截图：iOS/Android WebView 经常无法栅格化 foreignObject，
    // 会触发“无法直接生成 PDF，已导出 HTML”的兜底。
    // 这里直接读取当前 Markdown DOM 的文本/图片位置，画到 canvas，再组装为 PDF。
    void html;
    return ((...args: any[]) => (null as any))();
  }

  

  

  private mapSelectableTextSpansToPdfObjects(
    textSpans: SelectablePdfTextSpan[],
    layout: PdfExportLayout,
    sliceTop: number,
    sliceHeight: number,
    page: Pick<BrowserPdfRasterPage, "pageWidthPt" | "pageHeightPt" | "imageXPt" | "imageYPt" | "imageWidthPt" | "imageHeightPt">
  ): BrowserPdfTextObject[] {
    if (textSpans.length === 0) return [];

    const xPtPerRenderedCssPx = page.imageWidthPt / Math.max(1, layout.renderedWidth);
    const yPtPerRenderedCssPx = page.imageHeightPt / Math.max(1, sliceHeight);
    const cropRight = layout.cropLeft + layout.cropWidth;
    const pageTop = sliceTop;
    const pageBottom = sliceTop + sliceHeight;
    const objects: BrowserPdfTextObject[] = [];

    for (const span of textSpans) {
      const text = span.text.replace(/\u0000/g, "");
      if (!text.trim()) continue;
      if (span.x + span.width < layout.cropLeft || span.x > cropRight) continue;

      const renderedLeft = (span.x - layout.cropLeft) * layout.scale;
      const renderedTop = span.y * layout.scale;
      const renderedWidth = Math.max(0.5, span.width * layout.scale);
      const renderedHeight = Math.max(0.5, span.height * layout.scale);
      const renderedBottom = renderedTop + renderedHeight;

      if (renderedBottom < pageTop || renderedTop > pageBottom) continue;

      const clippedLeft = Math.max(0, renderedLeft);
      const clippedTop = Math.max(pageTop, renderedTop);
      const clippedRight = Math.min(layout.renderedWidth, renderedLeft + renderedWidth);
      const clippedBottom = Math.min(pageBottom, renderedBottom);
      if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) continue;

      const xPt = page.imageXPt + clippedLeft * xPtPerRenderedCssPx;
      const topPtFromImageTop = (clippedTop - pageTop) * yPtPerRenderedCssPx;
      const widthPt = Math.max(0.5, (clippedRight - clippedLeft) * xPtPerRenderedCssPx);
      const heightPt = Math.max(0.5, (clippedBottom - clippedTop) * yPtPerRenderedCssPx);
      const fontSizePt = Math.max(1, span.fontSize * layout.scale * yPtPerRenderedCssPx);
      const lineTopYPt = page.imageYPt + page.imageHeightPt - topPtFromImageTop;
      const baselineYPt = Math.max(page.imageYPt, lineTopYPt - Math.min(heightPt * 0.78, fontSizePt * 0.88));

      objects.push({
        text,
        xPt,
        baselineYPt,
        widthPt,
        heightPt,
        fontSizePt
      });
    }

    return objects;
  }

  private getSafeBrowserPdfSlices(layout: PdfExportLayout, pageContentHeight: number): Array<{ top: number; height: number }> {
    const totalHeight = Math.max(1, Math.ceil(layout.renderedHeight));
    const maxSliceHeight = Math.max(1, Math.floor(pageContentHeight));
    if (totalHeight <= maxSliceHeight) {
      return [{ top: 0, height: totalHeight }];
    }

    const avoidRanges = this.collectPdfPageBreakAvoidRanges(layout.scale);
    const slices: Array<{ top: number; height: number }> = [];
    let sliceTop = 0;

    while (sliceTop < totalHeight - 1) {
      const naturalBreak = Math.min(totalHeight, sliceTop + maxSliceHeight);
      if (naturalBreak >= totalHeight) {
        slices.push({ top: sliceTop, height: Math.max(1, totalHeight - sliceTop) });
        break;
      }

      const safeBreak = this.findSafePdfPageBreak(sliceTop, naturalBreak, avoidRanges, maxSliceHeight);
      const clampedBreak = Math.min(totalHeight, Math.max(sliceTop + 1, safeBreak));
      slices.push({ top: sliceTop, height: Math.max(1, clampedBreak - sliceTop) });
      sliceTop = clampedBreak;
    }

    return slices.length > 0 ? slices : [{ top: 0, height: totalHeight }];
  }

  private findSafePdfPageBreak(
    sliceTop: number,
    naturalBreak: number,
    avoidRanges: Array<{ top: number; bottom: number }>,
    maxSliceHeight: number
  ): number {
    const guard = PDF_PAGE_BREAK_GUARD_PX;
    const minimumUsefulHeight = Math.min(180, Math.max(72, maxSliceHeight * 0.18));
    const minBreak = sliceTop + minimumUsefulHeight;
    let candidate = naturalBreak;

    // 不再把连续文本行合并成一个大范围。分页线只要撞到当前文字行，
    // 就逐行向上移动到该行上方，而不是回退到整段/整页开头。
    for (let attempts = 0; attempts < 160; attempts++) {
      const hit = avoidRanges.find((range) => range.top < candidate && range.bottom > candidate);
      if (!hit) {
        return Math.max(minBreak, Math.min(naturalBreak, Math.floor(candidate)));
      }

      candidate = Math.floor(hit.top - guard);
      if (candidate <= minBreak) {
        break;
      }
    }

    // 如果自然分页点处在一整段密集文本里，向上找不到足够可用空间，
    // 就尝试向下放到当前文字行之后。之后会被下一轮切片继续分页。
    const firstHit = avoidRanges.find((range) => range.top < naturalBreak && range.bottom > naturalBreak);
    if (firstHit) {
      const afterHit = Math.ceil(firstHit.bottom + guard);
      if (afterHit > sliceTop && afterHit - sliceTop <= maxSliceHeight) {
        return afterHit;
      }
    }

    // 最后兜底：至少向上退一个小安全距离，避免刚好压在字形中线。
    return Math.max(minBreak, naturalBreak - guard * 2);
  }

  private collectPdfPageBreakAvoidRanges(scale: number): Array<{ top: number; bottom: number }> {
    const ranges: Array<{ top: number; bottom: number }> = [];

    const guard = PDF_PAGE_BREAK_GUARD_PX;

    for (const rect of this.collectPdfTextLineRects()) {
      const top = Math.floor(rect.y * scale - guard * 0.5);
      const bottom = Math.ceil((rect.y + rect.height) * scale + guard);
      if (bottom <= top) continue;
      ranges.push({ top: Math.max(0, top), bottom: Math.max(0, bottom) });
    }

    for (const rect of this.collectPdfMathRects()) {
      const top = Math.floor(rect.y * scale - guard);
      const bottom = Math.ceil((rect.y + rect.height) * scale + guard);
      if (bottom <= top) continue;
      ranges.push({ top: Math.max(0, top), bottom: Math.max(0, bottom) });
    }

    // 对较短的手写笔画也做分页避让，避免刚好把一行注釈切成上下两半。
    for (const stroke of this.engine?.getStrokes() ?? []) {
      const bounds = this.getStrokeBounds(stroke);
      if (!bounds || bounds.height <= 0 || bounds.height > 180) continue;
      const strokePadding = Math.max(2, stroke.width / 2 + 2);
      const top = Math.floor((bounds.y - strokePadding) * scale);
      const bottom = Math.ceil((bounds.y + bounds.height + strokePadding) * scale);
      if (bottom <= top) continue;
      ranges.push({ top: Math.max(0, top), bottom: Math.max(0, bottom) });
    }

    // 注意：这里故意不合并相邻文本行。合并会把整段文字变成一个大避让区，
    // 导致安全分页点搜索失败，最终又回到自然分页点并截断文字。
    return ranges.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  }

  private collectPdfMathRects(): PageRect[] {
    const elements = this.getPdfFormulaElements();
    const targets = elements.length > 0 ? elements : this.getPdfMathSvgElements();
    return targets
      .map((element) => this.getElementPageRect(element))
      .filter((rect): rect is PageRect => !!rect && rect.width > 0 && rect.height > 0);
  }

  

  

  

  private async drawCurrentBackgroundToCanvas(
    context: CanvasRenderingContext2D,
    includeImages: boolean,
    formulaMode: PdfFormulaRenderMode = "svg"
  ): Promise<void> {
    if (!this.backgroundEl) return;

    if (this.standalone) {
      ((...args: any[]) => (null as any))(context);
      if (includeImages) {
        await ((...args: any[]) => (null as any))(context);
      }
      return;
    }

    this.drawElementBoxesToCanvas(context);
    if (includeImages) {
      await this.drawImagesToCanvas(context);
    }
    await this.drawFormulasToCanvas(context, formulaMode);
    this.drawTextNodesToCanvas(context);
  }

  

  

  

  

  private addRoundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
  }

  private drawElementBoxesToCanvas(context: CanvasRenderingContext2D): void {
    if (!this.backgroundEl) return;

    const selector = [
      "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
      ".callout", ".markdown-embed", ".internal-embed", "mark"
    ].join(",");

    for (const element of Array.from(this.backgroundEl.querySelectorAll<HTMLElement>(selector))) {
      const rect = this.getElementPageRect(element);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;

      const style = getComputedStyle(element);
      const backgroundColor = style.backgroundColor;
      if (backgroundColor && !this.isTransparentCssColor(backgroundColor)) {
        context.save();
        context.globalAlpha = this.getCssOpacity(style);
        context.fillStyle = backgroundColor;
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
        context.restore();
      }

      this.drawElementBorderToCanvas(context, rect, style);
    }
  }

  private drawElementBorderToCanvas(context: CanvasRenderingContext2D, rect: PageRect, style: CSSStyleDeclaration): void {
    const sides: Array<["Top" | "Right" | "Bottom" | "Left", number, number, number, number]> = [
      ["Top", rect.x, rect.y, rect.x + rect.width, rect.y],
      ["Right", rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height],
      ["Bottom", rect.x, rect.y + rect.height, rect.x + rect.width, rect.y + rect.height],
      ["Left", rect.x, rect.y, rect.x, rect.y + rect.height]
    ];

    context.save();
    for (const [side, x1, y1, x2, y2] of sides) {
      const sideName = side.toLowerCase();
      const width = Number.parseFloat(style.getPropertyValue(`border-${sideName}-width`));
      const borderStyle = style.getPropertyValue(`border-${sideName}-style`);
      const color = style.getPropertyValue(`border-${sideName}-color`);
      if (!Number.isFinite(width) || width <= 0 || borderStyle === "none" || this.isTransparentCssColor(color)) continue;

      context.strokeStyle = color;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
    }
    context.restore();
  }

  private async drawImagesToCanvas(context: CanvasRenderingContext2D): Promise<void> {
    if (!this.backgroundEl) return;

    for (const image of Array.from(this.backgroundEl.querySelectorAll<HTMLImageElement>("img"))) {
      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) continue;
      if (!this.isCanvasSafeImage(image)) continue;

      const rect = this.getElementPageRect(image);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;

      try {
        context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      } catch {
        // 某些远程图片或系统资源会污染 canvas；跳过图片，保留文字和标注导出。
      }
    }
  }

  private async drawFormulasToCanvas(
    context: CanvasRenderingContext2D,
    mode: PdfFormulaRenderMode = "svg"
  ): Promise<void> {
    if (!this.backgroundEl || mode === "none") return;

    const formulaElements = this.getPdfFormulaElements();
    const formulaSources = await this.getMarkdownFormulaSources();

    if (mode === "text") {
      const handledSvgs = new Set<SVGSVGElement>();
      for (let index = 0; index < formulaElements.length; index++) {
        const formula = formulaElements[index];
        const fallbackText = formulaSources[index] ?? this.extractFormulaText(formula);
        this.drawFormulaTextFallbackToCanvas(context, formula, fallbackText);
        for (const svg of this.getPdfMathSvgElementsFrom(formula)) {
          handledSvgs.add(svg);
        }
      }

      const orphanSvgs = this.getPdfMathSvgElements().filter((svg) => !handledSvgs.has(svg));
      for (let index = 0; index < orphanSvgs.length; index++) {
        const svg = orphanSvgs[index];
        const fallbackText = formulaSources[formulaElements.length + index] ?? this.extractFormulaText(svg);
        this.drawFormulaTextFallbackToCanvas(context, svg, fallbackText);
      }
      return;
    }

    const drawnSvgs = new Set<SVGSVGElement>();

    for (let index = 0; index < formulaElements.length; index++) {
      const formula = formulaElements[index];
      const svgs = this.getPdfMathSvgElementsFrom(formula);
      const fallbackText = formulaSources[index] ?? this.extractFormulaText(formula);
      let drewFormula = false;

      for (const svg of svgs) {
        drewFormula = await this.drawSingleMathSvgToCanvas(context, svg) || drewFormula;
        drawnSvgs.add(svg);
      }

      // MathJax 在移动端可能是 CHTML，也可能是 SVG+外部 defs。SVG 画不出来时，
      // 先尝试容器快照，最后绘制原始 LaTeX/MathML 文本，保证公式不会整块消失。
      if (!drewFormula && svgs.length === 0) {
        drewFormula = await this.drawFormulaElementSnapshotToCanvas(context, formula);
      }
      if (!drewFormula) {
        this.drawFormulaTextFallbackToCanvas(context, formula, fallbackText);
      }
    }

    const orphanSvgs = this.getPdfMathSvgElements().filter((svg) => !drawnSvgs.has(svg));
    for (let index = 0; index < orphanSvgs.length; index++) {
      const svg = orphanSvgs[index];
      const fallbackText = formulaSources[formulaElements.length + index] ?? this.extractFormulaText(svg);
      const drewFormula = await this.drawSingleMathSvgToCanvas(context, svg);
      if (!drewFormula) {
        this.drawFormulaTextFallbackToCanvas(context, svg, fallbackText);
      }
    }
  }

  private async drawMathSvgToCanvas(context: CanvasRenderingContext2D): Promise<void> {
    await this.drawFormulasToCanvas(context);
  }

  private async drawSingleMathSvgToCanvas(context: CanvasRenderingContext2D, svg: SVGSVGElement): Promise<boolean> {
    const rect = this.getElementPageRect(svg);
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;

    try {
      const svgMarkup = this.serializeMathSvgToMarkup(svg, rect);
      const image = await this.svgToImage(svgMarkup);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      return true;
    } catch (blobError) {
      try {
        // 部分移动端 WebView 对 blob: SVG 支持不稳定，改用 base64 data URL 再试一次。
        const image = await this.loadImage(this.serializeMathSvgToDataUrl(svg, rect));
        context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
        return true;
      } catch (dataUrlError) {
        console.warn("Note Ink: failed to draw Markdown formula SVG into PDF canvas", blobError, dataUrlError);
        return false;
      }
    }
  }

  private async drawFormulaElementSnapshotToCanvas(context: CanvasRenderingContext2D, element: Element): Promise<boolean> {
    const rect = this.getElementPageRect(element);
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;

    try {
      const clone = element.cloneNode(true) as Element;
      if (clone instanceof HTMLElement) {
        clone.style.margin = "0";
        clone.style.maxWidth = "none";
      }

      const width = Math.max(1, Math.ceil(rect.width));
      const height = Math.max(1, Math.ceil(rect.height));
      const styles = `${((...args: any[]) => (null as any))()}\n${((...args: any[]) => (null as any))()}\n${this.getFormulaSnapshotCss()}`;
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:visible;background:transparent;color:${this.escapeAttribute(getComputedStyle(element).color || "#1f2328")};">
      <style>${this.toXmlCdata(styles)}</style>
      ${clone instanceof HTMLElement ? clone.outerHTML : new XMLSerializer().serializeToString(clone)}
    </div>
  </foreignObject>
</svg>`;
      const image = await this.svgToImage(svg);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      return true;
    } catch (error) {
      console.warn("Note Ink: failed to snapshot Markdown formula into PDF canvas", error);
      return false;
    }
  }

  private drawFormulaTextFallbackToCanvas(context: CanvasRenderingContext2D, element: Element, explicitText?: string): void {
    const rect = this.getElementPageRect(element);
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    const text = (explicitText || this.extractFormulaText(element)).replace(/\s+/g, " ").trim();
    if (!text) return;

    const style = getComputedStyle(element);
    const fontSize = Math.max(12, Number.parseFloat(style.fontSize || "16") || 16);
    const lineHeight = Math.max(fontSize * 1.25, Number.parseFloat(style.lineHeight || "0") || 0);

    context.save();
    context.globalAlpha = this.getCssOpacity(style);
    context.fillStyle = style.color || "#1f2328";
    context.font = this.getCanvasFont(style);
    context.textBaseline = "top";

    const maxWidth = Math.max(1, rect.width);
    const lines = this.wrapCanvasText(context, text, maxWidth);
    const isDisplayFormula = element.getAttribute("display") === "true"
      || !!element.closest(".math-block, .block-language-math, .katex-display")
      || (element instanceof HTMLElement && getComputedStyle(element).display === "block");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const measured = context.measureText(line).width;
      const x = isDisplayFormula ? rect.x + Math.max(0, (rect.width - measured) / 2) : rect.x;
      context.fillText(line, x, rect.y + i * lineHeight, maxWidth);
    }
    context.restore();
  }

  private getFormulaSnapshotCss(): string {
    return `
html, body { margin: 0 !important; padding: 0 !important; background: transparent !important; }
mjx-container, .MathJax, .math, .math-block, .math-inline, .block-language-math, .katex, .katex-display {
  visibility: visible !important;
  opacity: 1 !important;
  color: inherit !important;
}
mjx-assistive-mml { display: none !important; }
svg { overflow: visible !important; }
`;
  }

  private getPdfFormulaElements(): Element[] {
    if (!this.backgroundEl) return [];

    const selector = [
      "mjx-container",
      ".MathJax",
      ".math",
      ".math-block",
      ".math-inline",
      ".block-language-math",
      ".katex-display",
      ".katex",
      "[data-math]",
      "[data-latex]"
    ].join(",");
    const elements: Element[] = [];
    const seen = new Set<Element>();

    for (const element of Array.from(this.backgroundEl.querySelectorAll(selector))) {
      if (seen.has(element)) continue;
      if (element.parentElement?.closest(selector)) continue;
      const rect = this.getElementPageRect(element);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      seen.add(element);
      elements.push(element);
    }

    return elements;
  }

  private getPdfMathSvgElements(): SVGSVGElement[] {
    if (!this.backgroundEl) return [];
    return this.getPdfMathSvgElementsFrom(this.backgroundEl);
  }

  private getPdfMathSvgElementsFrom(root: ParentNode): SVGSVGElement[] {
    const selector = [
      "mjx-container svg",
      ".MathJax svg",
      ".math svg",
      ".math-block svg",
      ".math-inline svg",
      ".block-language-math svg",
      ".katex svg",
      ".katex-display svg",
      ".markdown-preview-view svg[data-mml-node]"
    ].join(",");
    const seen = new Set<SVGSVGElement>();
    const result: SVGSVGElement[] = [];

    for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>(selector))) {
      if (seen.has(svg)) continue;
      if (!this.isMathSvgElement(svg)) continue;
      seen.add(svg);
      result.push(svg);
    }

    return result;
  }

  private isMathSvgElement(svg: SVGSVGElement): boolean {
    if (svg.closest("mjx-container, .MathJax, .math, .math-block, .math-inline, .block-language-math, .katex, .katex-display")) return true;
    return !!svg.querySelector("[data-mml-node]");
  }

  private serializeMathSvgToDataUrl(svg: SVGSVGElement, rect: PageRect): string {
    return this.svgMarkupToDataUrl(this.serializeMathSvgToMarkup(svg, rect));
  }

  private serializeMathSvgToMarkup(svg: SVGSVGElement, rect: PageRect): string {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const computed = getComputedStyle(svg);
    const container = svg.closest("mjx-container, .MathJax, .math, .math-block, .math-inline, .block-language-math, .katex, .katex-display");
    const color = computed.color
      || getComputedStyle(container ?? this.backgroundEl ?? document.body).color
      || "#1f2328";
    const width = Math.max(1, Math.ceil(rect.width));
    const height = Math.max(1, Math.ceil(rect.height));

    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", `${width}`);
    clone.setAttribute("height", `${height}`);
    clone.setAttribute("preserveAspectRatio", clone.getAttribute("preserveAspectRatio") || "xMidYMid meet");
    if (!clone.getAttribute("viewBox")) {
      const sourceViewBox = svg.getAttribute("viewBox");
      clone.setAttribute("viewBox", sourceViewBox || `0 0 ${width} ${height}`);
    }
    clone.style.color = color;
    clone.style.overflow = "visible";
    clone.style.display = "inline-block";
    clone.style.visibility = "visible";
    clone.style.opacity = "1";

    this.inlineExternalMathSvgUseDefinitions(svg, clone);

    for (const use of Array.from(clone.querySelectorAll("use"))) {
      const href = use.getAttribute("href") || use.getAttribute("xlink:href");
      if (href) {
        use.setAttribute("href", href);
        use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
      }
    }

    for (const element of Array.from(clone.querySelectorAll("path, use, text, tspan"))) {
      const currentFill = element.getAttribute("fill");
      if (!currentFill || currentFill === "currentColor") {
        element.setAttribute("fill", color);
      }
      const currentStroke = element.getAttribute("stroke");
      if (currentStroke === "currentColor") {
        element.setAttribute("stroke", color);
      }
    }

    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `svg { color: ${color}; overflow: visible; } path, use, text, tspan { fill: ${color}; }`;
    clone.insertBefore(style, clone.firstChild);

    return new XMLSerializer().serializeToString(clone);
  }

  private inlineExternalMathSvgUseDefinitions(sourceSvg: SVGSVGElement, clone: SVGSVGElement): void {
    const requiredIds = new Set<string>();
    for (const use of Array.from(sourceSvg.querySelectorAll("use"))) {
      const href = use.getAttribute("href") || use.getAttribute("xlink:href");
      if (href?.startsWith("#")) {
        requiredIds.add(href.slice(1));
      }
    }

    if (requiredIds.size === 0) return;

    let defs = clone.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      clone.insertBefore(defs, clone.firstChild);
    }

    for (const id of requiredIds) {
      if (this.findSvgDescendantById(clone, id)) continue;

      const sourceDefinition = this.findSvgDescendantById(sourceSvg, id)
        ?? this.findSvgDescendantById(this.backgroundEl, id)
        ?? this.findSvgDescendantById(document, id);
      if (sourceDefinition) {
        defs.appendChild(sourceDefinition.cloneNode(true));
      }
    }
  }

  private findSvgDescendantById(root: ParentNode | null, id: string): Element | null {
    if (!root) return null;

    for (const element of Array.from(root.querySelectorAll<Element>("[id]"))) {
      if (element.id === id) return element;
    }
    return null;
  }

  private svgMarkupToDataUrl(svgMarkup: string): string {
    const normalizedMarkup = svgMarkup
      .replace(/<svg\b(?![^>]*\sxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"')
      .replace(/<svg\b(?![^>]*\sxmlns:xlink=)/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');

    const bytes = new TextEncoder().encode(normalizedMarkup);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return `data:image/svg+xml;charset=utf-8;base64,${btoa(binary)}`;
  }

  private async getMarkdownFormulaSources(): Promise<string[]> {
    if (this.standalone || !this.sourcePath) return [];

    const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return [];

    try {
      const markdown = await this.app.vault.cachedRead(file);
      return this.extractMarkdownFormulaSources(markdown);
    } catch {
      return [];
    }
  }

  private extractMarkdownFormulaSources(markdown: string): string[] {
    const result: string[] = [];
    let index = 0;

    while (index < markdown.length) {
      if (markdown.startsWith("```", index) || markdown.startsWith("~~~", index)) {
        const fence = markdown.slice(index, index + 3);
        const lineEnd = markdown.indexOf("\n", index + 3);
        index = lineEnd < 0 ? markdown.length : lineEnd + 1;
        const close = markdown.indexOf(fence, index);
        if (close < 0) break;
        index = close + 3;
        continue;
      }

      if (markdown.startsWith("$$", index)) {
        const end = markdown.indexOf("$$", index + 2);
        if (end > index + 2) {
          result.push(markdown.slice(index + 2, end).trim());
          index = end + 2;
          continue;
        }
      }

      if (markdown.startsWith("\\[", index)) {
        const end = markdown.indexOf("\\]", index + 2);
        if (end > index + 2) {
          result.push(markdown.slice(index + 2, end).trim());
          index = end + 2;
          continue;
        }
      }

      if (markdown.startsWith("\\(", index)) {
        const end = markdown.indexOf("\\)", index + 2);
        if (end > index + 2) {
          result.push(markdown.slice(index + 2, end).trim());
          index = end + 2;
          continue;
        }
      }

      if (markdown[index] === "$" && markdown[index - 1] !== "\\" && markdown[index + 1] !== "$") {
        let end = index + 1;
        while (end < markdown.length) {
          if (markdown[end] === "$" && markdown[end - 1] !== "\\" && markdown[end + 1] !== "$") break;
          if (markdown[end] === "\n") break;
          end++;
        }
        if (end < markdown.length && markdown[end] === "$" && end > index + 1) {
          const content = markdown.slice(index + 1, end).trim();
          if (content) result.push(content);
          index = end + 1;
          continue;
        }
      }

      index++;
    }

    return result;
  }

  private extractFormulaText(element: Element): string {
    const directAttributes = [
      "aria-label",
      "data-latex",
      "data-tex",
      "data-math",
      "data-original",
      "alt",
      "title"
    ];

    for (const attribute of directAttributes) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) return value;
    }

    const script = element.querySelector("script[type*='math/tex'], script[type*='latex']");
    const scriptText = script?.textContent?.trim();
    if (scriptText) return scriptText;

    const annotation = element.querySelector("annotation[encoding*='tex' i], annotation[encoding*='latex' i]");
    const annotationText = annotation?.textContent?.trim();
    if (annotationText) return annotationText;

    const assistive = element.querySelector("mjx-assistive-mml, .MJX_Assistive_MathML");
    const assistiveText = assistive?.textContent?.replace(/\s+/g, " ").trim();
    if (assistiveText) return assistiveText;

    return (element.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  private wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    if (context.measureText(text).width <= maxWidth) return [text];

    const tokens = text.split(/(\s+)/).filter((token) => token.length > 0);
    const lines: string[] = [];
    let current = "";

    for (const token of tokens) {
      const next = current ? `${current}${token}` : token.trimStart();
      if (next && context.measureText(next).width <= maxWidth) {
        current = next;
        continue;
      }

      if (current.trim()) {
        lines.push(current.trimEnd());
      }
      current = token.trimStart();
    }

    if (current.trim()) {
      lines.push(current.trimEnd());
    }

    return lines.length > 0 ? lines : [text];
  }

  private loadImage(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      if (/^https?:\/\//i.test(source)) {
        image.crossOrigin = "anonymous";
      }
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load export image"));
      image.src = source;
    });
  }

  private drawTextNodesToCanvas(context: CanvasRenderingContext2D): void {
    if (!this.backgroundEl) return;

    const nodeFilter = window.NodeFilter ?? NodeFilter;
    const walker = document.createTreeWalker(this.backgroundEl, nodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.textContent ?? "";
        if (!text || text.trim().length === 0) return nodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || this.shouldSkipTextElement(parent)) return nodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) {
          return nodeFilter.FILTER_REJECT;
        }
        return nodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent) continue;

      const style = getComputedStyle(parent);
      const lines = this.collectCanvasTextLines(textNode);
      if (lines.length === 0) continue;

      context.save();
      context.globalAlpha = this.getCssOpacity(style);
      context.fillStyle = style.color || "#1f2328";
      context.font = this.getCanvasFont(style);
      context.textBaseline = "top";
      context.direction = style.direction === "rtl" ? "rtl" : "ltr";

      for (const line of lines) {
        if (!line.text.trim()) continue;
        context.fillText(line.text, line.x, line.y);
      }
      context.restore();
    }
  }

  private collectCanvasTextLines(textNode: Text): Array<{ text: string; x: number; y: number }> {
    if (!this.backgroundEl) return [];

    const text = textNode.textContent ?? "";
    const range = document.createRange();
    const lines: Array<{ text: string; x: number; y: number; right: number }> = [];
    let activeLine: { text: string; x: number; y: number; right: number } | null = null;
    let pendingWhitespace = "";

    try {
      for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (character === "\n" || character === "\r") {
          pendingWhitespace = "";
          activeLine = null;
          continue;
        }

        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const rect = this.getFirstUsefulClientRect(range.getClientRects());

        if (!rect) {
          if (activeLine) {
            activeLine.text += character;
          } else {
            pendingWhitespace += character;
          }
          continue;
        }

        const pageRect = this.clientRectToPageRect(rect);
        if (!pageRect) continue;
        const x = pageRect.x;
        const y = pageRect.y;
        const right = pageRect.x + pageRect.width;
        if (!activeLine
          || Math.abs(y - activeLine.y) > 3
          || x + 1 < activeLine.right - 2) {
          activeLine = {
            text: `${pendingWhitespace}${character}`,
            x,
            y,
            right
          };
          lines.push(activeLine);
          pendingWhitespace = "";
        } else {
          activeLine.text += `${pendingWhitespace}${character}`;
          activeLine.right = Math.max(activeLine.right, right);
          pendingWhitespace = "";
        }
      }
    } finally {
      range.detach();
    }

    return lines.map((line) => ({ text: line.text, x: line.x, y: line.y }));
  }

  private getFirstUsefulClientRect(rectList: DOMRectList): DOMRect | null {
    for (const rect of Array.from(rectList)) {
      if (rect.width > 0.2 && rect.height > 0.2) return rect;
    }
    return null;
  }

  private shouldSkipTextElement(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    if (["script", "style", "svg", "canvas", "button", "input", "textarea", "select"].includes(tagName)) {
      return true;
    }
    return !!element.closest(".mobile-ink-toolbar, .mobile-ink-selection-layer, .mobile-ink-pdf-strokes, mjx-assistive-mml, mjx-container, .MathJax, .math, .math-block, .math-inline, .block-language-math, .katex, .katex-display");
  }

  private getCanvasFont(style: CSSStyleDeclaration): string {
    const fontStyle = style.fontStyle && style.fontStyle !== "normal" ? style.fontStyle : "normal";
    const fontVariant = style.fontVariant && style.fontVariant !== "normal" ? style.fontVariant : "normal";
    const fontWeight = style.fontWeight || "400";
    const fontSize = style.fontSize || "16px";
    const lineHeight = style.lineHeight && style.lineHeight !== "normal" ? `/${style.lineHeight}` : "";
    const fontFamily = style.fontFamily || "system-ui, sans-serif";
    return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize}${lineHeight} ${fontFamily}`;
  }

  

  private drawInkStrokesToCanvas(context: CanvasRenderingContext2D, strokes: InkStroke[]): void {
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const stroke of strokes) {
      const points = stroke.points;
      if (points.length === 0) continue;

      context.globalAlpha = stroke.tool === "highlighter" ? 0.32 : 1;
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.width;

      if (points.length === 1) {
        context.beginPath();
        context.arc(points[0].x, points[0].y, Math.max(0.5, stroke.width / 2), 0, Math.PI * 2);
        context.fill();
        continue;
      }

      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        context.lineTo(points[i].x, points[i].y);
      }
      context.stroke();
    }

    context.restore();
  }

  private getElementPageRect(element: Element): PageRect | null {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return this.clientRectToPageRect(rect);
  }

  private clientRectToPageRect(rect: DOMRect | DOMRectReadOnly): PageRect | null {
    const page = this.pageEl;
    if (!page) return null;

    const pageRect = page.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return null;

    // getBoundingClientRect() 已经包含当前预览缩放 transform；手写笔迹坐标则是
    // 未缩放的页面逻辑坐标。导出时必须把 DOM 坐标还原到同一个逻辑坐标系，
    // 否则 PC 端/移动端只要视图不是 100% 缩放，就会出现标注整体偏移。
    const scaleX = this.pageLogicalWidth / pageRect.width;
    const scaleY = this.pageLogicalHeight / pageRect.height;
    const x = (rect.left - pageRect.left) * scaleX;
    const y = (rect.top - pageRect.top) * scaleY;
    const right = (rect.right - pageRect.left) * scaleX;
    const bottom = (rect.bottom - pageRect.top) * scaleY;

    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y)
    };
  }

  private getCanvasBackgroundColor(): string {
    const color = getComputedStyle(this.backgroundEl ?? document.body).backgroundColor;
    return color && !this.isTransparentCssColor(color) ? color : "#ffffff";
  }

  private isTransparentCssColor(color: string): boolean {
    const normalized = color.trim().toLowerCase();
    return !normalized
      || normalized === "transparent"
      || normalized === "rgba(0, 0, 0, 0)"
      || normalized === "rgba(0,0,0,0)"
      || /rgba\([^)]*,\s*0\s*\)$/.test(normalized);
  }

  private getCssOpacity(style: CSSStyleDeclaration): number {
    const opacity = Number.parseFloat(style.opacity || "1");
    return Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
  }

  private isCanvasSafeImage(image: HTMLImageElement): boolean {
    const source = image.currentSrc || image.src || "";
    if (!source) return false;
    if (/^https?:\/\//i.test(source)) return false;
    return true;
  }

  

  

  private async svgToImage(svg: string): Promise<HTMLImageElement> {
    // Prefer a self-contained data URL. Some WebViews/Electron builds taint canvas
    // after drawing blob: SVG images, which then makes canvas.toDataURL() fail.
    try {
      return await this.loadImage(this.svgMarkupToDataUrl(svg));
    } catch {
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);

      try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("Browser PDF export failed to rasterize SVG"));
          image.src = url;
        });
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    }
  }

  private toXmlCdata(value: string): string {
    return `<![CDATA[${value.replace(/\]\]>/g, "]]\]><![CDATA[>")}]]>`;
  }

  private bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  private dataUrlToBytes(dataUrl: string): Uint8Array {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Invalid image data URL");
    }

    const binary = atob(dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private escapeAttribute(value: string): string {
    return this.escapeHtml(value)
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private async saveNow(): Promise<void> {
    if (!this.annotation || !this.engine || !this.pageEl) return;

    this.engine.flushPendingStrokes();

    const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
    const sourceMtime = file instanceof TFile ? file.stat.mtime : this.annotation.sourceMtime;
    const markdownLayout = !this.standalone && !this.isPdfPath(this.sourcePath)
      ? this.collectMarkdownLayoutSnapshot() ?? this.currentMarkdownLayout ?? undefined
      : undefined;
    this.currentMarkdownLayout = markdownLayout ?? null;

    const allStrokes = this.engine.getStrokes();

    // For standalone multi-page notes, split strokes by page bounds
    let pages: typeof this.annotation.pages = undefined;
    const singlePageH = this.annotation.pageHeight;
    if (this.standalone && this.standalonePageCount > 0 && singlePageH > 0) {
      const pageGap = 24;
      pages = Array.from({ length: this.standalonePageCount }, (_, i) => {
        const pageTop = i * (singlePageH + pageGap);
        const pageBottom = pageTop + singlePageH;
        const pageStrokes = allStrokes.filter(s => {
          const sy = Math.min(...s.points.map(p => p.y));
          const ey = Math.max(...s.points.map(p => p.y));
          // Stroke overlaps this page's Y range
          return ey >= pageTop && sy < pageBottom;
        });
        return { pageNumber: i + 1, strokes: pageStrokes };
      });
    }

    const annotation: AnnotationFile = {
      version: 1,
      sourcePath: this.sourcePath,
      sourceMtime,
      pageWidth: Math.ceil(this.pageLogicalWidth),
      pageHeight: Math.ceil(singlePageH > 0 ? singlePageH : this.pageLogicalHeight),
      strokes: this.standalone ? [] : allStrokes,
      markdownLayout,
      pdfTextAnnotations: !this.standalone ? [...this.pdfTextAnnotations] : [],
      template: this.standalone ? (this.annotation.template ?? "blank") : undefined,
      pages: this.standalone ? pages : undefined,
      elements: this.standalone ? [...(this.annotation.elements ?? [])] : undefined,
      updatedAt: Date.now()
    };

    this.annotation = annotation;
    if (this.standalone) {
      await this.plugin.store.saveStandalone(annotation);
    } else {
      await this.plugin.store.save(annotation);
    }
  }

  // ===== PDF 文本选择与注釈（移植自完整版 V1.3） =====

  private addPdfTextAnnotation(kind: PdfTextAnnotationKind, colorOverride?: string): void {
    if (!this.plugin.hasFeature("pdfTextAnnotation")) {
      new Notice("この版ではPDFの文字注釈を利用できません。");
      return;
    }

    if (!this.pdfTextSelection || this.pdfTextSelection.rects.length === 0) {
      this.refreshPdfTextSelection();
    }
    const selection = this.pdfTextSelection;
    if (!selection || selection.rects.length === 0) return;

    const color = colorOverride ?? this.pdfTextAnnotationColors[kind];
    if (colorOverride) {
      this.setPdfTextAnnotationColor(kind, colorOverride);
    }

    if (kind === "note") return;
    this.commitPdfTextAnnotation(kind, selection, undefined, color);
  }

  private beginPdfTextSelection(
    entry: PdfBackgroundPageEntry,
    pointerId: number,
    point: PagePoint,
    captureTarget?: HTMLElement,
    currentPoint = point
  ): void {
    document.getSelection()?.removeAllRanges();
    this.hidePdfTextMenu();
    this.hidePdfAnnotationMenu();
    this.pdfTextSelection = null;
    this.pdfTextSelectionIsCustom = false;
    this.pdfTextDragSelection = {
      pointerId,
      pageNumber: entry.pageNumber,
      start: point,
      current: currentPoint
    };
    this.clearPdfTextDragHighlights();
    const target = captureTarget ?? entry.textLayer;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort here; selection still completes on pointerup.
    }
  }

  private async beginPdfTextSelectionAfterTextLayerRender(
    entry: PdfBackgroundPageEntry,
    pending: PdfPendingTextSelectionState
  ): Promise<void> {
    await this.renderPdfTextLayer(entry, pending.token);
    if (!this.selectMode || !this.isPdfPath(this.sourcePath) || pending.token !== this.pdfRenderToken) return;
    if (this.pdfPendingTextSelection !== pending || this.pdfTextDragSelection !== null) return;

    this.pdfPendingTextSelection = null;
    this.beginPdfTextSelection(entry, pending.pointerId, pending.start, undefined, pending.current);
    if (pending.released) {
      this.finishPdfTextSelection(entry, pending.current);
      return;
    }

    const selection = this.getPdfTextSelectionFromDrag(entry, this.pdfTextDragSelection!);
    this.renderPdfTextDragHighlights(selection?.rects ?? []);
  }

  private cancelPdfTextSelectionRefresh(): void {
    if (this.pdfTextSelectionRefreshTimer === null) return;

    window.clearTimeout(this.pdfTextSelectionRefreshTimer);
    this.pdfTextSelectionRefreshTimer = null;
  }

  private clearPdfTextDragHighlights(): void {
    this.backgroundEl?.querySelectorAll(".mobile-ink-pdf-text-selection-highlight").forEach((element) => element.remove());
    this.markdownTextAnnotationLayerEl?.querySelectorAll(".mobile-ink-pdf-text-selection-highlight").forEach((element) => element.remove());
  }

  private clearPdfTextLayers(): void {
    for (const entry of this.pdfBackgroundPages) {
      entry.textLayer.empty();
      entry.textItems = [];
      entry.textRendered = false;
      entry.textRendering = false;
    }
  }

  private clearPdfTextSelectionUi(clearNativeSelection = true): void {
    this.pdfTextSelection = null;
    this.pdfTextDragSelection = null;
    this.clearMarkdownTextSelectionHold();
    this.pdfTextSelectionIsCustom = false;
    this.clearPdfTextDragHighlights();
    this.hidePdfTextMenu();
    this.hidePdfAnnotationMenu();
    if (clearNativeSelection) {
      document.getSelection()?.removeAllRanges();
    }
  }

  private clonePdfTextSelection(selection: PdfTextSelectionState): PdfTextSelectionState {
    return {
      text: selection.text,
      rects: selection.rects.map((rect) => ({ ...rect })),
      menuPoint: { ...selection.menuPoint },
      visualOnly: selection.visualOnly
    };
  }

  private commitPdfTextAnnotation(kind: PdfTextAnnotationKind, selection: PdfTextSelectionState, note?: string, colorOverride?: string): void {
    if (!this.plugin.hasFeature("pdfTextAnnotation")) return;
    if (selection.rects.length === 0) return;

    const color = colorOverride ?? this.pdfTextAnnotationColors[kind];
    const grouped = new Map<number, PageRect[]>();

    for (const rect of selection.rects) {
      const list = grouped.get(rect.pageNumber) ?? [];
      list.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      });
      grouped.set(rect.pageNumber, list);
    }

    for (const [pageNumber, rects] of grouped) {
      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === pageNumber);
      this.pdfTextAnnotations.push({
        id: crypto.randomUUID(),
        kind,
        pageNumber,
        pageWidth: Math.max(1, Math.ceil(this.isPdfPath(this.sourcePath) ? entry?.viewport.width ?? this.pageLogicalWidth : this.pageLogicalWidth)),
        pageHeight: Math.max(1, Math.ceil(this.isPdfPath(this.sourcePath) ? entry?.viewport.height ?? this.pageLogicalHeight : this.pageLogicalHeight)),
        color,
        text: selection.visualOnly ? "" : selection.text,
        rects,
        note,
        createdAt: Date.now()
      });
    }

    this.renderPdfTextAnnotations();
    this.saveQueue?.markDirty();
    this.clearPdfTextSelectionUi();
  }

  private createPdfTextMenu(menu: HTMLElement): void {
    if (!this.plugin.hasFeature("pdfTextAnnotation")) return;

    menu.setAttribute("aria-label", "PDFの文字注釈");
    const actions = menu.createDiv({ cls: "mobile-ink-pdf-menu-actions" });
    this.createPdfMenuButton(actions, "copy", "コピー", () => {
      void this.copyPdfSelectedText();
    }, { disabled: () => !this.pdfTextSelection?.text || this.pdfTextSelection?.visualOnly === true, showText: false });
    const highlightButton = this.createPdfMenuButton(actions, "highlighter", "ハイライト", (event) => {
      this.handlePdfTextAnnotationButton("highlight", event);
    }, { disabled: () => !this.pdfTextSelection?.rects.length, swatch: this.pdfTextAnnotationColors.highlight, chevron: true, showText: false });
    highlightButton.dataset.pdfAnnotationKind = "highlight";
    const underlineButton = this.createPdfMenuButton(actions, "underline", "下線", (event) => {
      this.handlePdfTextAnnotationButton("underline", event);
    }, { disabled: () => !this.pdfTextSelection?.rects.length, swatch: this.pdfTextAnnotationColors.underline, chevron: true, showText: false });
    underlineButton.dataset.pdfAnnotationKind = "underline";
    const strikethroughButton = this.createPdfMenuButton(actions, "strikethrough", "取り消し線", (event) => {
      this.handlePdfTextAnnotationButton("strikethrough", event);
    }, { disabled: () => !this.pdfTextSelection?.rects.length, swatch: this.pdfTextAnnotationColors.strikethrough, chevron: true, showText: false });
    strikethroughButton.dataset.pdfAnnotationKind = "strikethrough";
    const colorPanel = menu.createDiv({ cls: "mobile-ink-pdf-color-panel" });
    this.createPdfColorRow(colorPanel, "highlight", (color) => this.addPdfTextAnnotation("highlight", color));
    this.createPdfColorRow(colorPanel, "underline", (color) => this.addPdfTextAnnotation("underline", color));
    this.createPdfColorRow(colorPanel, "strikethrough", (color) => this.addPdfTextAnnotation("strikethrough", color));
  }

  private createPdfAnnotationMenu(menu: HTMLElement): void {
    if (!this.plugin.hasFeature("pdfTextAnnotation")) return;

    menu.setAttribute("aria-label", "PDFの注釈操作");
    menu.createDiv({ cls: "mobile-ink-pdf-annotation-menu-summary" });
    const actions = menu.createDiv({ cls: "mobile-ink-pdf-menu-actions" });
    this.createPdfMenuButton(actions, "copy", "コピー", () => {
      void this.copyActivePdfAnnotationText();
    }, { disabled: () => !this.getActivePdfTextAnnotation()?.text, showText: true });
    this.createPdfMenuButton(actions, "trash-2", "削除", () => {
      this.deleteActivePdfTextAnnotation();
    }, { disabled: () => !this.activePdfTextAnnotationId, danger: true, showText: true });

    const colorPanel = menu.createDiv({ cls: "mobile-ink-pdf-color-panel mobile-ink-pdf-color-panel-open" });
    this.createPdfColorRow(colorPanel, "highlight", (color) => this.updateActivePdfAnnotationColor(color));
  }

  private createVisualPdfTextSelection(entry: PdfBackgroundPageEntry, rect: PageRect, text: string): PdfTextSelectionState | null {
    const pageWidth = Math.max(1, Math.ceil(entry.viewport.width));
    const pageHeight = Math.max(1, Math.ceil(entry.viewport.height));
    const x = Math.min(Math.max(rect.x, 0), pageWidth);
    const y = Math.min(Math.max(rect.y, 0), pageHeight);
    const width = Math.min(Math.max(rect.width, 1), Math.max(1, pageWidth - x));
    const height = Math.min(Math.max(rect.height, 1), Math.max(1, pageHeight - y));
    if (width < 4 || height < 4) return null;

    return {
      text,
      visualOnly: true,
      rects: [{
        pageNumber: entry.pageNumber,
        x,
        y,
        width,
        height
      }],
      menuPoint: {
        x: x + width / 2,
        y: entry.offsetY + Math.max(0, y - 42)
      }
    };
  }

  private deleteActivePdfTextAnnotation(): void {
    const annotationId = this.activePdfTextAnnotationId;
    if (!annotationId) return;

    const next = this.pdfTextAnnotations.filter((annotation) => annotation.id !== annotationId);
    if (next.length === this.pdfTextAnnotations.length) return;

    this.pdfTextAnnotations = next;
    this.renderPdfTextAnnotations();
    this.hidePdfAnnotationMenu();
    this.saveQueue?.markDirty();
    new Notice("PDFの注釈を削除しました。");
  }

  private estimatePdfTextCharacterWidth(char: string, fontHeight: number): number {
    if (/\s/.test(char)) return fontHeight * 0.32;
    if (/[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) return fontHeight;
    return fontHeight * 0.56;
  }

  private estimatePdfTextItemWidth(text: string, fontHeight: number): number {
    let width = 0;
    for (const char of Array.from(text)) {
      if (/\s/.test(char)) {
        width += fontHeight * 0.32;
      } else if (/[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) {
        width += fontHeight;
      } else {
        width += fontHeight * 0.56;
      }
    }

    return Math.max(fontHeight * 0.45, width);
  }

  private estimatePdfTextSelectionLineHeight(entry: PdfBackgroundPageEntry, y: number): number {
    let nearest: PdfTextLayerItem | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const fallbackHeights: number[] = [];

    for (const item of entry.textItems) {
      if (!Number.isFinite(item.height) || item.height <= 0) continue;
      if (fallbackHeights.length < 80) {
        fallbackHeights.push(item.height);
      }

      const itemTop = item.y;
      const itemBottom = item.y + item.height;
      const distance = y < itemTop ? itemTop - y : y > itemBottom ? y - itemBottom : 0;
      if (distance < nearestDistance) {
        nearest = item;
        nearestDistance = distance;
      }
    }

    if (nearest) {
      return Math.min(Math.max(nearest.height, 8), 48);
    }

    if (fallbackHeights.length === 0) return 16;
    fallbackHeights.sort((a, b) => a - b);
    const middle = fallbackHeights[Math.floor(fallbackHeights.length / 2)] ?? 16;
    return Math.min(Math.max(middle, 8), 48);
  }

  private findPdfTextLineIndex(lines: Array<{ y: number; height: number; items: PdfTextLayerItem[] }>, point: PagePoint): number {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const lineTop = line.y - Math.max(4, line.height * 0.45);
      const lineBottom = line.y + line.height + Math.max(4, line.height * 0.45);
      const distance = point.y < lineTop ? lineTop - point.y : point.y > lineBottom ? point.y - lineBottom : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  private finishPdfTextSelection(entry: PdfBackgroundPageEntry, point: PagePoint): void {
    const drag = this.pdfTextDragSelection;
    if (!drag) return;

    drag.current = point;
    this.pdfTextDragSelection = null;
    this.pdfTextSelection = this.getPdfTextSelectionFromDrag(entry, drag);
    this.pdfTextSelectionIsCustom = this.pdfTextSelection !== null;
    this.renderPdfTextDragHighlights(this.pdfTextSelection?.rects ?? []);

    if (this.pdfTextSelection) {
      this.showPdfTextMenuAt(this.pdfTextSelection.menuPoint);
    } else {
      this.hidePdfTextMenu();
    }
  }

  private getActivePdfTextAnnotation(): PdfTextAnnotation | null {
    if (!this.activePdfTextAnnotationId) return null;
    return this.pdfTextAnnotations.find((annotation) => annotation.id === this.activePdfTextAnnotationId) ?? null;
  }

  private getPdfTextCharacterLines(entry: PdfBackgroundPageEntry): Array<{ y: number; height: number; items: PdfTextLayerItem[] }> {
    const chars = entry.textItems
      .flatMap((item) => this.getPdfTextItemCharacterFragments(item))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: Array<{ y: number; height: number; items: PdfTextLayerItem[] }> = [];

    for (const char of chars) {
      const charCenterY = char.y + char.height / 2;
      const line = lines.find((candidate) => {
        const lineCenterY = candidate.y + candidate.height / 2;
        return Math.abs(charCenterY - lineCenterY) <= Math.max(4, Math.min(char.height, candidate.height) * 0.72);
      });

      if (line) {
        const bottom = Math.max(line.y + line.height, char.y + char.height);
        line.y = Math.min(line.y, char.y);
        line.height = Math.max(1, bottom - line.y);
        line.items.push(char);
        line.items.sort((a, b) => a.x - b.x);
      } else {
        lines.push({
          y: char.y,
          height: char.height,
          items: [char]
        });
      }
    }

    return lines.sort((a, b) => a.y - b.y);
  }

  private getPdfTextDragSelectionRect(entry: PdfBackgroundPageEntry, drag: PdfTextDragSelectionState): PageRect | null {
    const rawX = Math.min(drag.start.x, drag.current.x);
    const rawY = Math.min(drag.start.y, drag.current.y);
    const rawWidth = Math.abs(drag.current.x - drag.start.x);
    const rawHeight = Math.abs(drag.current.y - drag.start.y);
    if (rawWidth < 2 && rawHeight < 2) return null;

    const centerX = (drag.start.x + drag.current.x) / 2;
    const centerY = (drag.start.y + drag.current.y) / 2;
    const lineHeight = this.estimatePdfTextSelectionLineHeight(entry, centerY);
    const minHeight = Math.max(12, lineHeight * 1.35);
    const minWidth = Math.max(8, lineHeight * 0.75);
    let x = rawX;
    let y = rawY;
    let width = rawWidth;
    let height = rawHeight;

    if (height < minHeight) {
      y = centerY - minHeight / 2;
      height = minHeight;
    }

    if (width < minWidth) {
      x = centerX - minWidth / 2;
      width = minWidth;
    }

    const pageWidth = Math.max(1, Math.ceil(entry.viewport.width));
    const pageHeight = Math.max(1, Math.ceil(entry.viewport.height));
    const clampedX = Math.min(Math.max(x, 0), pageWidth);
    const clampedY = Math.min(Math.max(y, 0), pageHeight);
    const clampedWidth = Math.min(Math.max(width, 1), Math.max(1, pageWidth - clampedX));
    const clampedHeight = Math.min(Math.max(height, 1), Math.max(1, pageHeight - clampedY));
    if (clampedWidth < 2 || clampedHeight < 2) return null;

    return {
      x: clampedX,
      y: clampedY,
      width: clampedWidth,
      height: clampedHeight
    };
  }

  private getPdfTextFlowSelectionFragments(
    lines: Array<{ y: number; height: number; items: PdfTextLayerItem[] }>,
    startLineIndex: number,
    startPoint: PagePoint,
    endLineIndex: number,
    endPoint: PagePoint
  ): PdfTextLayerItem[] {
    let fromLineIndex = startLineIndex;
    let toLineIndex = endLineIndex;
    let fromX = startPoint.x;
    let toX = endPoint.x;

    if (fromLineIndex > toLineIndex || (fromLineIndex === toLineIndex && fromX > toX)) {
      fromLineIndex = endLineIndex;
      toLineIndex = startLineIndex;
      fromX = endPoint.x;
      toX = startPoint.x;
    }

    const selected: PdfTextLayerItem[] = [];
    for (let lineIndex = fromLineIndex; lineIndex <= toLineIndex; lineIndex++) {
      const line = lines[lineIndex];
      if (!line) continue;

      const lineItems = line.items.filter((item) => {
        const centerX = item.x + item.width / 2;
        if (fromLineIndex === toLineIndex) return centerX >= fromX && centerX <= toX;
        if (lineIndex === fromLineIndex) return centerX >= fromX;
        if (lineIndex === toLineIndex) return centerX <= toX;
        return true;
      });
      selected.push(...this.mergeAdjacentPdfTextFragments(lineItems));
    }

    return selected;
  }

  private getPdfTextItemCharacterFragments(item: PdfTextLayerItem): PdfTextLayerItem[] {
    const chars = Array.from(item.text);
    if (chars.length <= 1) return [item];

    const weights = chars.map((char) => this.estimatePdfTextCharacterWidth(char, item.height));
    const totalWeight = weights.reduce((sum, width) => sum + width, 0);
    if (totalWeight <= 0) return [item];

    const scale = item.width / totalWeight;
    let cursorX = item.x;
    return chars.map((char, index) => {
      const charWidth = Math.max(0.5, weights[index] * scale);
      const fragment = {
        pageNumber: item.pageNumber,
        text: char,
        x: cursorX,
        y: item.y,
        width: charWidth,
        height: item.height,
        hasEOL: item.hasEOL && index === chars.length - 1
      };
      cursorX += charWidth;
      return fragment;
    });
  }

  private getPdfTextItemHitRect(item: PdfTextLayerItem): PageRect {
    const padX = Math.max(4, item.height * 0.28);
    const padY = Math.max(3, item.height * 0.45);
    return {
      x: item.x - padX,
      y: item.y - padY,
      width: item.width + padX * 2,
      height: item.height + padY * 2
    };
  }

  private getPdfTextItemSelectionFragments(item: PdfTextLayerItem, selectionRect: PageRect): PdfTextLayerItem[] {
    if (!this.rectsIntersect(selectionRect, this.getPdfTextItemHitRect(item))) return [];

    const fragments = this.getPdfTextItemCharacterFragments(item);
    const selected = fragments.filter((fragment) => this.rectsIntersect(selectionRect, fragment)
      || this.pointInRect({ x: fragment.x + fragment.width / 2, y: fragment.y + fragment.height / 2 }, selectionRect));
    return this.mergeAdjacentPdfTextFragments(selected);
  }

  private getPdfTextSelectionFragments(entry: PdfBackgroundPageEntry, drag: PdfTextDragSelectionState, selectionRect: PageRect): PdfTextLayerItem[] {
    const lines = this.getPdfTextCharacterLines(entry);
    if (lines.length === 0) {
      return entry.textItems.flatMap((item) => this.getPdfTextItemSelectionFragments(item, selectionRect));
    }

    const startLineIndex = this.findPdfTextLineIndex(lines, drag.start);
    const endLineIndex = this.findPdfTextLineIndex(lines, drag.current);
    if (startLineIndex !== -1 && endLineIndex !== -1) {
      return this.getPdfTextFlowSelectionFragments(lines, startLineIndex, drag.start, endLineIndex, drag.current);
    }

    return lines.flatMap((line) => this.mergeAdjacentPdfTextFragments(
      line.items.filter((item) => this.rectsIntersect(selectionRect, item)
        || this.pointInRect({ x: item.x + item.width / 2, y: item.y + item.height / 2 }, selectionRect))
    ));
  }

  private getPdfTextSelectionFromDrag(entry: PdfBackgroundPageEntry, drag: PdfTextDragSelectionState): PdfTextSelectionState | null {
    const selectionRect = this.getPdfTextDragSelectionRect(entry, drag);
    if (!selectionRect) return null;

    const selected = this.getPdfTextSelectionFragments(entry, drag, selectionRect)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (selected.length === 0) {
      return this.createVisualPdfTextSelection(entry, selectionRect, "");
    }

    const rects = mergePdfSelectionRects(selected.map((item) => ({
      pageNumber: item.pageNumber,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    })));
    const text = this.buildPdfSelectedText(selected);
    if (this.shouldUseVisualPdfSelectionFallback(selectionRect, rects, text)) {
      return this.createVisualPdfTextSelection(entry, selectionRect, text);
    }
    if (!text) {
      return this.createVisualPdfTextSelection(entry, selectionRect, "");
    }

    const first = rects[0];
    return {
      text,
      rects,
      menuPoint: {
        x: first.x + first.width / 2,
        y: entry.offsetY + Math.max(0, first.y - 42)
      }
    };
  }

  private getPdfTextSelectionRects(range: Range): PdfTextSelectionRect[] {
    const result: PdfTextSelectionRect[] = [];

    for (const clientRect of Array.from(range.getClientRects())) {
      if (clientRect.width <= 0.5 || clientRect.height <= 0.5) continue;

      for (const entry of this.pdfBackgroundPages) {
        const pageRect = entry.pageEl.getBoundingClientRect();
        const left = Math.max(clientRect.left, pageRect.left);
        const right = Math.min(clientRect.right, pageRect.right);
        const top = Math.max(clientRect.top, pageRect.top);
        const bottom = Math.min(clientRect.bottom, pageRect.bottom);
        if (right <= left || bottom <= top) continue;

        const scaleX = Math.max(1, Math.ceil(entry.viewport.width)) / Math.max(1, pageRect.width);
        const scaleY = Math.max(1, Math.ceil(entry.viewport.height)) / Math.max(1, pageRect.height);
        result.push({
          pageNumber: entry.pageNumber,
          x: Math.max(0, (left - pageRect.left) * scaleX),
          y: Math.max(0, (top - pageRect.top) * scaleY),
          width: Math.max(1, (right - left) * scaleX),
          height: Math.max(1, (bottom - top) * scaleY)
        });
      }
    }

    return mergePdfSelectionRects(result);
  }

  private getPdfTextTouchPointerId(identifier: number): number {
    return -1000000 - identifier;
  }

  private handlePdfTextAnnotationButton(kind: Extract<PdfTextAnnotationKind, "highlight" | "underline" | "strikethrough">, event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".mobile-ink-pdf-menu-chevron")) {
      this.togglePdfTextColorPanel(kind);
      return;
    }

    this.addPdfTextAnnotation(kind, this.pdfTextAnnotationColors[kind]);
  }

  private hasMeaningfulPdfText(text: string): boolean {
    return /[A-Za-z\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(text);
  }

  private hidePdfTextColorPanel(): void {
    const panel = this.pdfTextMenuEl?.querySelector<HTMLElement>(".mobile-ink-pdf-color-panel");
    if (!panel) return;

    panel.classList.remove("mobile-ink-pdf-color-panel-open");
    panel.removeAttribute("data-kind");
    for (const row of Array.from(panel.querySelectorAll<HTMLElement>(".mobile-ink-pdf-color-row"))) {
      row.classList.remove("mobile-ink-pdf-color-row-active");
    }
  }

  private hidePdfTextMenu(): void {
    if (this.pdfTextMenuEl) {
      this.pdfTextMenuEl.style.display = "none";
    }
    this.hidePdfTextColorPanel();
  }

  private isNodeInsidePdfTextLayer(node: Node | null): boolean {
    if (!node) return false;
    const element = node instanceof Element ? node : node.parentElement;
    return !!element?.closest(".mobile-ink-pdf-text-layer");
  }

  private mergeAdjacentPdfTextFragments(items: PdfTextLayerItem[]): PdfTextLayerItem[] {
    const sorted = [...items].sort((a, b) => a.x - b.x);
    const merged: PdfTextLayerItem[] = [];

    for (const item of sorted) {
      const last = merged[merged.length - 1];
      const adjacent = last
        && last.pageNumber === item.pageNumber
        && Math.abs(last.y - item.y) <= Math.max(2, Math.min(last.height, item.height) * 0.35)
        && item.x <= last.x + last.width + Math.max(1, item.height * 0.08);

      if (adjacent) {
        const right = Math.max(last.x + last.width, item.x + item.width);
        last.text += item.text;
        last.width = right - last.x;
        last.height = Math.max(last.height, item.height);
        last.hasEOL = item.hasEOL;
        continue;
      }

      merged.push({ ...item });
    }

    return merged;
  }

  private onPdfTextDocumentSelectionChange = (): void => {
    if (!this.selectMode || this.standalone) return;
    this.schedulePdfTextSelectionRefresh();
  };

  private onPdfTextLayerPointerCancel = (event: PointerEvent): void => {
    if (!this.isPdfPath(this.sourcePath)) return;

    if (this.pdfPendingTextSelection?.pointerId === event.pointerId) {
      this.pdfPendingTextSelection = null;
      return;
    }

    const drag = this.pdfTextDragSelection;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.pdfTextDragSelection = null;
    this.clearPdfTextDragHighlights();
  };

  private onPdfTextLayerPointerMove = (event: PointerEvent): void => {
    if (!this.isPdfPath(this.sourcePath)) return;

    const pending = this.pdfPendingTextSelection;
    if (pending?.pointerId === event.pointerId) {
      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === pending.pageNumber);
      const point = entry ? this.pdfPointerEventToPagePoint(event, entry) : null;
      if (!entry || !point) return;

      event.preventDefault();
      event.stopPropagation();
      pending.current = point;
      return;
    }

    const drag = this.pdfTextDragSelection;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === drag.pageNumber);
    const point = entry ? this.pdfPointerEventToPagePoint(event, entry) : null;
    if (!entry || !point) return;

    event.preventDefault();
    event.stopPropagation();
    drag.current = point;
    const selection = this.getPdfTextSelectionFromDrag(entry, drag);
    this.renderPdfTextDragHighlights(selection?.rects ?? []);
  };

  private onPdfTextLayerPointerUp = (event: PointerEvent): void => {
    if (!this.isPdfPath(this.sourcePath)) return;

    const pending = this.pdfPendingTextSelection;
    if (pending?.pointerId === event.pointerId) {
      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === pending.pageNumber);
      const point = entry ? this.pdfPointerEventToPagePoint(event, entry) : null;
      if (point) pending.current = point;
      pending.released = true;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const drag = this.pdfTextDragSelection;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === drag.pageNumber);
    const point = entry ? this.pdfPointerEventToPagePoint(event, entry) : null;
    if (!entry || !point) {
      this.pdfTextDragSelection = null;
      this.clearPdfTextDragHighlights();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.finishPdfTextSelection(entry, point);
  };

  private onPdfTextPointerDown = (event: PointerEvent): void => {
    if (!this.selectMode || !this.isPdfPath(this.sourcePath)) return;
    if (this.activePdfTextTouchId !== null || this.pdfTextDragSelection || this.pdfPendingTextSelection) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-pdf-text-menu, .mobile-ink-pdf-annotation-menu, .modal-container")) return;
    if (event.target.closest(".mobile-ink-pdf-text-annotation, .mobile-ink-pdf-text-note-marker")) return;

    const entry = this.getPdfEntryFromPointerEvent(event);
    const point = entry ? this.pdfPointerEventToPagePoint(event, entry) : null;
    if (!entry || !point) return;

    event.preventDefault();
    event.stopPropagation();

    if (entry.textItems.length === 0) {
      const pending: PdfPendingTextSelectionState = {
        pointerId: event.pointerId,
        pageNumber: entry.pageNumber,
        start: point,
        current: point,
        token: this.pdfRenderToken,
        released: false
      };
      this.pdfPendingTextSelection = pending;
      void this.beginPdfTextSelectionAfterTextLayerRender(entry, pending);
      return;
    }

    this.beginPdfTextSelection(entry, event.pointerId, point, event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined);
  };

  private onPdfTextSelectionFinished = (event: Event): void => {
    if (!this.selectMode || this.standalone) return;
    if (event.target instanceof Element && event.target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-text-menu, .mobile-ink-pdf-annotation-menu, .mobile-ink-pdf-text-annotation-layer, .mobile-ink-markdown-text-annotation-layer")) return;

    this.schedulePdfTextSelectionRefresh();
  };

  private onPdfTextTouchCancel = (event: TouchEvent): void => {
    if (this.activePdfTextTouchId === null) return;

    const touch = this.findChangedTouchById(event, this.activePdfTextTouchId);
    if (!touch) return;

    const pointerId = this.getPdfTextTouchPointerId(touch.identifier);
    if (this.pdfPendingTextSelection?.pointerId === pointerId) {
      this.pdfPendingTextSelection = null;
    }
    if (this.pdfTextDragSelection?.pointerId === pointerId) {
      this.pdfTextDragSelection = null;
      this.clearPdfTextDragHighlights();
    }
    this.activePdfTextTouchId = null;
  };

  private onPdfTextTouchEnd = (event: TouchEvent): void => {
    if (this.activePdfTextTouchId === null) return;

    const touch = this.findChangedTouchById(event, this.activePdfTextTouchId);
    if (!touch) return;

    const pointerId = this.getPdfTextTouchPointerId(touch.identifier);
    const pending = this.pdfPendingTextSelection;
    if (pending?.pointerId === pointerId) {
      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === pending.pageNumber);
      const point = entry ? this.clientToPdfPagePoint(touch.clientX, touch.clientY, entry) : null;
      if (point) pending.current = point;
      pending.released = true;
      this.activePdfTextTouchId = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const drag = this.pdfTextDragSelection;
    if (!drag || drag.pointerId !== pointerId) return;

    const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === drag.pageNumber);
    const point = entry ? this.clientToPdfPagePoint(touch.clientX, touch.clientY, entry) : null;
    this.activePdfTextTouchId = null;
    if (!entry || !point) {
      this.pdfTextDragSelection = null;
      this.clearPdfTextDragHighlights();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.finishPdfTextSelection(entry, point);
  };

  private onPdfTextTouchMove = (event: TouchEvent): void => {
    if (this.activePdfTextTouchId === null) return;

    const touch = this.findChangedTouchById(event, this.activePdfTextTouchId);
    if (!touch) return;

    const pointerId = this.getPdfTextTouchPointerId(touch.identifier);
    const pending = this.pdfPendingTextSelection;
    if (pending?.pointerId === pointerId) {
      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === pending.pageNumber);
      const point = entry ? this.clientToPdfPagePoint(touch.clientX, touch.clientY, entry) : null;
      if (!entry || !point) return;

      event.preventDefault();
      event.stopPropagation();
      pending.current = point;
      return;
    }

    const drag = this.pdfTextDragSelection;
    if (!drag || drag.pointerId !== pointerId) return;

    const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === drag.pageNumber);
    const point = entry ? this.clientToPdfPagePoint(touch.clientX, touch.clientY, entry) : null;
    if (!entry || !point) return;

    event.preventDefault();
    event.stopPropagation();
    drag.current = point;
    const selection = this.getPdfTextSelectionFromDrag(entry, drag);
    this.renderPdfTextDragHighlights(selection?.rects ?? []);
  };

  private onPdfTextTouchStart = (event: TouchEvent): void => {
    if (!this.selectMode || !this.isPdfPath(this.sourcePath)) return;
    if (this.activePdfTextTouchId !== null || this.pdfTextDragSelection || this.pdfPendingTextSelection) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".mobile-ink-toolbar, .mobile-ink-pdf-page-nav, .mobile-ink-pdf-text-menu, .mobile-ink-pdf-annotation-menu, .modal-container")) return;
    if (event.target.closest(".mobile-ink-pdf-text-annotation, .mobile-ink-pdf-text-note-marker")) return;

    const touch = event.changedTouches.item(0);
    if (!touch) return;

    const entry = this.getPdfEntryFromClientPoint(touch.clientX, touch.clientY, event.target);
    const point = entry ? this.clientToPdfPagePoint(touch.clientX, touch.clientY, entry) : null;
    if (!entry || !point) return;

    event.preventDefault();
    event.stopPropagation();
    this.activePdfTextTouchId = touch.identifier;
    const pointerId = this.getPdfTextTouchPointerId(touch.identifier);

    if (entry.textItems.length === 0) {
      const pending: PdfPendingTextSelectionState = {
        pointerId,
        pageNumber: entry.pageNumber,
        start: point,
        current: point,
        token: this.pdfRenderToken,
        released: false
      };
      this.pdfPendingTextSelection = pending;
      void this.beginPdfTextSelectionAfterTextLayerRender(entry, pending);
      return;
    }

    this.beginPdfTextSelection(entry, pointerId, point);
  };

  private preparePdfTextAnnotationsForCurrentLayout(annotations: PdfTextAnnotation[], savedPageWidth: number): PdfTextAnnotation[] {
    return annotations.map((annotation) => {
      if (Number.isFinite(annotation.pageWidth) && annotation.pageWidth && annotation.pageWidth > 0
        && Number.isFinite(annotation.pageHeight) && annotation.pageHeight && annotation.pageHeight > 0) {
        return {
          ...annotation,
          rects: annotation.rects.map((rect) => ({ ...rect }))
        };
      }

      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === annotation.pageNumber);
      const currentWidth = Math.max(1, Math.ceil(entry?.viewport.width ?? this.pageLogicalWidth));
      const currentHeight = Math.max(1, Math.ceil(entry?.viewport.height ?? currentWidth * 1.414));
      const legacyWidth = Number.isFinite(savedPageWidth) && savedPageWidth > 0 ? savedPageWidth : currentWidth;
      const legacyHeight = currentHeight * (legacyWidth / currentWidth);

      return {
        ...annotation,
        pageWidth: legacyWidth,
        pageHeight: legacyHeight,
        rects: annotation.rects.map((rect) => ({ ...rect }))
      };
    });
  }

  private queueCurrentPdfTextLayersRender(): void {
    if (!this.selectMode || !this.pdfScrollEl || this.pdfBackgroundPages.length === 0) return;

    const currentPage = this.pdfPageNavigator.getCurrentPageNumber();
    const token = this.pdfRenderToken;
    for (const entry of this.pdfBackgroundPages) {
      if (Math.abs(entry.pageNumber - currentPage) > 1) continue;
      void this.renderPdfTextLayer(entry, token);
    }
  }

  private queueVisiblePdfTextLayersRender(): void {
    if (!this.selectMode || !this.pdfScrollEl || this.pdfBackgroundPages.length === 0) return;

    const token = this.pdfRenderToken;
    const marginPx = this.isMobileLike()
      ? Math.max(this.pdfScrollEl.clientHeight * 0.25, 160)
      : Math.max(this.pdfScrollEl.clientHeight * 0.8, 520);
    const margin = marginPx / Math.max(0.001, this.zoom);
    const visibleRange = this.getVisibleLogicalYRange();

    for (const entry of this.pdfBackgroundPages) {
      if (entry.offsetY + entry.viewport.height < visibleRange.top - margin
        || entry.offsetY > visibleRange.bottom + margin) continue;
      void this.renderPdfTextLayer(entry, token);
    }
  }

  private refreshPdfTextMenuColors(): void {
    const menu = this.pdfTextMenuEl;
    if (!menu) return;

    for (const kind of ["highlight", "underline", "strikethrough", "note"] as PdfTextAnnotationKind[]) {
      const button = menu.querySelector<HTMLElement>(`[data-pdf-annotation-kind="${kind}"]`);
      const swatch = button?.querySelector<HTMLElement>(".mobile-ink-pdf-menu-swatch");
      if (swatch) {
        swatch.style.backgroundColor = this.pdfTextAnnotationColors[kind];
      }
    }
  }

  private refreshPdfTextSelection(): void {
    if (this.pdfTextSelectionIsCustom) {
      return;
    }

    if (!this.plugin.hasFeature("pdfTextAnnotation")) {
      this.hidePdfTextMenu();
      this.pdfTextSelection = null;
      return;
    }

    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.hidePdfTextMenu();
      this.pdfTextSelection = null;
      return;
    }

    const selectingPdf = this.isPdfPath(this.sourcePath);
    const selectionInsideTarget = selectingPdf
      ? this.isNodeInsidePdfTextLayer(selection.anchorNode) || this.isNodeInsidePdfTextLayer(selection.focusNode)
      : this.isNodeInsideMarkdownBackground(selection.anchorNode) || this.isNodeInsideMarkdownBackground(selection.focusNode);
    if (!selectionInsideTarget) {
      this.hidePdfTextMenu();
      this.pdfTextSelection = null;
      return;
    }

    const range = selection.getRangeAt(0);
    const rects = selectingPdf
      ? this.getPdfTextSelectionRects(range)
      : this.getMarkdownTextSelectionRects(range);
    const text = selection.toString().trim();
    if (rects.length === 0 || !text) {
      this.hidePdfTextMenu();
      this.pdfTextSelection = null;
      return;
    }

    const first = rects[0];
    this.pdfTextSelection = {
      text,
      rects,
      menuPoint: {
        x: first.x + first.width / 2,
        y: (selectingPdf ? this.getPdfPageOffsetY(first.pageNumber) : 0) + Math.max(0, first.y - 42)
      },
      visualOnly: false
    };
    this.pdfTextSelectionIsCustom = false;
    this.showPdfTextMenuAt(this.pdfTextSelection.menuPoint);
  }

  private renderPdfTextAnnotations(): void {
    if (!this.plugin.hasFeature("pdfTextAnnotation")) return;

    if (!this.isPdfPath(this.sourcePath)) {
      this.renderMarkdownTextAnnotations();
      return;
    }

    for (const entry of this.pdfBackgroundPages) {
      this.renderPdfTextAnnotationsForPage(entry);
    }
  }

  private renderPdfTextAnnotationsForPage(entry: PdfBackgroundPageEntry): void {
    entry.annotationLayer.empty();
    if (!this.plugin.hasFeature("pdfTextAnnotation")) return;

    entry.annotationLayer.style.width = `${Math.max(1, Math.ceil(entry.viewport.width))}px`;
    entry.annotationLayer.style.height = `${Math.max(1, Math.ceil(entry.viewport.height))}px`;

    for (const annotation of this.pdfTextAnnotations) {
      if (annotation.kind === "note") continue;
      if (annotation.pageNumber !== entry.pageNumber) continue;

      for (let index = 0; index < annotation.rects.length; index++) {
        const rect = annotation.rects[index];
        const displayRect = this.getPdfAnnotationDisplayRect(annotation, rect, entry);
        const el = entry.annotationLayer.createDiv({
          cls: `mobile-ink-pdf-text-annotation mobile-ink-pdf-text-annotation-${annotation.kind}`
        });
        el.dataset.annotationId = annotation.id;
        el.dataset.annotationLabel = this.getPdfAnnotationLabel(annotation);
        el.style.left = `${displayRect.x}px`;
        el.style.width = `${displayRect.width}px`;
        el.style.backgroundColor = annotation.color;

        if (annotation.kind === "underline") {
          el.style.top = `${displayRect.y + Math.max(1, displayRect.height - 2)}px`;
          el.style.height = "2px";
        } else if (annotation.kind === "strikethrough") {
          el.style.top = `${displayRect.y + Math.max(1, Math.round(displayRect.height / 2) - 1)}px`;
          el.style.height = "2px";
        } else {
          el.style.top = `${displayRect.y}px`;
          el.style.height = `${displayRect.height}px`;
        }

        this.bindPdfAnnotationMenuTarget(el, annotation, entry, displayRect);

      }
    }
  }

  private renderPdfTextDragHighlights(rects: PdfTextSelectionRect[]): void {
    this.clearPdfTextDragHighlights();

    for (const rect of rects) {
      const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === rect.pageNumber);
      if (!entry) continue;

      const highlight = entry.textLayer.createDiv({ cls: "mobile-ink-pdf-text-selection-highlight" });
      highlight.style.left = `${rect.x}px`;
      highlight.style.top = `${rect.y}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    }
  }

  private async renderPdfTextLayer(entry: PdfBackgroundPageEntry, token: number): Promise<void> {
    if (entry.textRendered || entry.textRendering || token !== this.pdfRenderToken) return;

    entry.textRendering = true;
    try {
      if (!entry.page) {
        if (!this.pdfBackgroundDocument) {
          throw new Error("PDF document is unavailable");
        }
        entry.page = await this.pdfBackgroundDocument.getPage(entry.pageNumber);
      }

      const width = Math.max(1, Math.ceil(entry.viewport.width));
      const height = Math.max(1, Math.ceil(entry.viewport.height));
      const baseViewport = entry.page.getViewport({ scale: 1 });
      const fitScale = Math.min(
        this.pdfBackgroundTargetWidth / Math.max(1, baseViewport.width),
        height / Math.max(1, baseViewport.height)
      );
      const renderViewport = entry.page.getViewport({ scale: fitScale });
      const offsetX = Math.max(0, (width - renderViewport.width) / 2);
      const offsetY = Math.max(0, (height - renderViewport.height) / 2);
      const viewportTransform = renderViewport.transform ?? [fitScale, 0, 0, -fitScale, 0, renderViewport.height] as PdfMatrix;
      const textContent = await entry.page.getTextContent();
      if (token !== this.pdfRenderToken) return;

      entry.textLayer.empty();
      entry.textLayer.style.width = `${width}px`;
      entry.textLayer.style.height = `${height}px`;
      entry.textItems = [];

      const spans: Array<{ el: HTMLSpanElement; targetWidth: number; angle: number }> = [];
      for (const item of textContent.items) {
        if (!item.str) continue;

        const transform = multiplyPdfMatrix(viewportTransform, item.transform);
        const style = item.fontName ? textContent.styles?.[item.fontName] : undefined;
        const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
        const ascent = typeof style?.ascent === "number" ? style.ascent : 0.8;
        const left = transform[4] + offsetX;
        const top = transform[5] + offsetY - fontHeight * ascent;
        const angle = Math.atan2(transform[1], transform[0]);
        const itemWidth = Number.isFinite(item.width) && item.width !== undefined && item.width > 0
          ? Math.abs(item.width) * fitScale
          : this.estimatePdfTextItemWidth(item.str, fontHeight);
        const itemHeight = Number.isFinite(item.height) && item.height !== undefined && item.height > 0
          ? Math.abs(item.height) * fitScale
          : fontHeight;
        const targetWidth = Math.max(1, itemWidth);
        const targetHeight = Math.max(1, itemHeight, fontHeight);

        const span = document.createElement("span");
        span.textContent = item.str;
        span.dir = item.dir === "rtl" ? "rtl" : "ltr";
        span.style.left = `${left}px`;
        span.style.top = `${top}px`;
        span.style.width = `${targetWidth}px`;
        span.style.height = `${targetHeight}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.lineHeight = `${targetHeight}px`;
        span.style.fontFamily = style?.fontFamily || "sans-serif";
        span.style.transform = `rotate(${angle}rad)`;
        span.dataset.text = item.str;
        span.dataset.pageNumber = String(entry.pageNumber);
        entry.textLayer.appendChild(span);
        spans.push({ el: span, targetWidth, angle });
        entry.textItems.push({
          pageNumber: entry.pageNumber,
          text: item.str,
          x: left,
          y: top,
          width: targetWidth,
          height: targetHeight,
          hasEOL: item.hasEOL
        });
      }

      for (const span of spans) {
        const rawWidth = Math.max(1, span.el.offsetWidth);
        const scaleX = Math.min(8, Math.max(0.2, span.targetWidth / rawWidth));
        span.el.style.transform = `rotate(${span.angle}rad) scaleX(${scaleX})`;
      }

      entry.textRendered = true;
    } catch (error) {
      console.warn(`Note Ink: failed to render PDF text layer ${entry.pageNumber}`, error);
    } finally {
      entry.textRendering = false;
    }
  }

  private schedulePdfTextSelectionRefresh(): void {
    if (this.pdfTextSelectionRefreshTimer !== null) {
      window.clearTimeout(this.pdfTextSelectionRefreshTimer);
    }

    this.pdfTextSelectionRefreshTimer = window.setTimeout(() => {
      this.pdfTextSelectionRefreshTimer = null;
      this.refreshPdfTextSelection();
    }, 80);
  }

  private setPdfTextAnnotationColor(kind: PdfTextAnnotationKind, color: string): void {
    this.pdfTextAnnotationColors[kind] = color;
    this.refreshPdfTextMenuColors();
  }

  private showPdfTextMenuAt(point: PagePoint): void {
    if (!this.plugin.hasFeature("pdfTextAnnotation")) return;
    if (!this.pdfTextMenuEl || !this.pdfTextSelection) return;

    this.hidePdfAnnotationMenu();
    this.hidePdfTextColorPanel();
    this.refreshPdfTextMenuColors();
    this.pdfTextMenuEl.style.display = "flex";
    this.pdfTextMenuEl.style.left = `${point.x}px`;
    this.pdfTextMenuEl.style.top = `${point.y}px`;

    requestAnimationFrame(() => {
      if (!this.pdfTextMenuEl) return;

      const menuWidth = this.pdfTextMenuEl.offsetWidth || 240;
      const menuHeight = this.pdfTextMenuEl.offsetHeight || 42;
      const position = this.getTextMenuPosition(point, menuWidth, menuHeight);
      this.pdfTextMenuEl.style.left = `${position.x}px`;
      this.pdfTextMenuEl.style.top = `${position.y}px`;
    });
  }

  private shouldInsertPdfTextSpace(previous: PdfTextLayerItem, current: PdfTextLayerItem): boolean {
    if (previous.text.endsWith(" ") || current.text.startsWith(" ")) return false;
    const gap = current.x - (previous.x + previous.width);
    if (gap <= Math.max(1.5, Math.min(previous.height, current.height) * 0.12)) return false;
    return /[A-Za-z0-9)\]}%]$/.test(previous.text) && /^[A-Za-z0-9([{]/.test(current.text);
  }

  private syncPdfTextColorChoices(kind: PdfTextAnnotationKind, color: string): void {
    const panel = this.pdfTextMenuEl?.querySelector<HTMLElement>(".mobile-ink-pdf-color-panel");
    const row = panel?.querySelector<HTMLElement>(`.mobile-ink-pdf-color-row[data-kind="${kind}"]`);
    if (!row) return;

    for (const button of Array.from(row.querySelectorAll<HTMLElement>(".mobile-ink-pdf-color-choice"))) {
      button.classList.toggle("mobile-ink-active", normalizeCssColor(button.dataset.color ?? "") === normalizeCssColor(color));
    }
  }

  private togglePdfTextColorPanel(kind: Extract<PdfTextAnnotationKind, "highlight" | "underline" | "strikethrough">): void {
    const menu = this.pdfTextMenuEl;
    if (!menu) return;

    const panel = menu.querySelector<HTMLElement>(".mobile-ink-pdf-color-panel");
    if (!panel) return;

    const isOpen = panel.classList.contains("mobile-ink-pdf-color-panel-open")
      && panel.dataset.kind === kind;
    if (isOpen) {
      this.hidePdfTextColorPanel();
      return;
    }

    panel.dataset.kind = kind;
    panel.classList.add("mobile-ink-pdf-color-panel-open");
    for (const row of Array.from(panel.querySelectorAll<HTMLElement>(".mobile-ink-pdf-color-row"))) {
      row.classList.toggle("mobile-ink-pdf-color-row-active", row.dataset.kind === kind);
    }
    this.syncPdfTextColorChoices(kind, this.pdfTextAnnotationColors[kind]);
  }

  private activateMarkdownTextSelectionHold(hold: MarkdownTextSelectionHoldState): void {
    if (this.markdownTextSelectionHold !== hold) return;

    hold.activated = true;
    this.cancelPdfTextSelectionRefresh();
    document.getSelection()?.removeAllRanges();
    this.hidePdfTextMenu();
    this.hidePdfAnnotationMenu();
    this.pdfTextSelection = null;
    this.pdfTextSelectionIsCustom = false;
    this.pdfTextDragSelection = {
      pointerId: hold.pointerId,
      pageNumber: 1,
      start: hold.start,
      current: hold.current
    };
    this.clearPdfTextDragHighlights();
    const selection = this.getMarkdownTextSelectionFromDrag(this.pdfTextDragSelection);
    this.renderMarkdownTextDragHighlights(selection?.rects ?? []);
    try {
      hold.target.setPointerCapture(hold.pointerId);
    } catch {
      // Pointer capture is best-effort for Markdown custom selection.
    }
  }

  private clearMarkdownTextSelectionHold(): void {
    const hold = this.markdownTextSelectionHold;
    if (!hold) return;

    window.clearTimeout(hold.timer);
    this.markdownTextSelectionHold = null;
    try {
      if (hold.target.hasPointerCapture(hold.pointerId)) {
        hold.target.releasePointerCapture(hold.pointerId);
      }
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  private getMarkdownTextSelectionFromDrag(drag: PdfTextDragSelectionState): PdfTextSelectionState | null {
    const items = this.getMarkdownTextItems();
    if (items.length === 0) return null;

    const lines = this.getMarkdownTextLines(items);
    const startLineIndex = this.findMarkdownTextLineIndex(lines, drag.start);
    const endLineIndex = this.findMarkdownTextLineIndex(lines, drag.current);
    const selected = startLineIndex !== -1 && endLineIndex !== -1
      ? this.getMarkdownTextFlowSelectionItems(lines, startLineIndex, drag.start, endLineIndex, drag.current)
      : this.getMarkdownTextRectSelectionItems(items, drag);
    if (selected.length === 0) {
      const fallback = this.findMarkdownTextItemAt(drag.current) ?? this.findMarkdownTextItemAt(drag.start);
      if (!fallback) return null;
      selected.push(fallback);
    }

    const text = this.buildMarkdownSelectedText(selected);
    const rects = mergePdfSelectionRects(selected.map((item) => ({
      pageNumber: 1,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    })));
    if (rects.length === 0 || !text.trim()) return null;

    const bounds = rects.reduce<PageRect | null>((result, rect) => {
      if (!result) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      return this.unionRects(result, rect);
    }, null);
    const menuAnchor = bounds ?? rects[0];
    return {
      text: text.trim(),
      rects,
      menuPoint: {
        x: menuAnchor.x + menuAnchor.width / 2,
        y: Math.max(0, menuAnchor.y - 42)
      },
      visualOnly: false
    };
  }

  private getMarkdownTextSelectionRects(range: Range): PdfTextSelectionRect[] {
    const result: PdfTextSelectionRect[] = [];
    const pageRect = this.pageEl?.getBoundingClientRect();
    if (!pageRect) return result;

    const scaleX = this.pageLogicalWidth / Math.max(1, pageRect.width);
    const scaleY = this.pageLogicalHeight / Math.max(1, pageRect.height);

    for (const clientRect of Array.from(range.getClientRects())) {
      if (clientRect.width <= 0.5 || clientRect.height <= 0.5) continue;

      const left = Math.max(clientRect.left, pageRect.left);
      const right = Math.min(clientRect.right, pageRect.right);
      const top = Math.max(clientRect.top, pageRect.top);
      const bottom = Math.min(clientRect.bottom, pageRect.bottom);
      if (right <= left || bottom <= top) continue;

      result.push({
        pageNumber: 1,
        x: Math.max(0, (left - pageRect.left) * scaleX),
        y: Math.max(0, (top - pageRect.top) * scaleY),
        width: Math.max(1, (right - left) * scaleX),
        height: Math.max(1, (bottom - top) * scaleY)
      });
    }

    return mergePdfSelectionRects(result);
  }

  private prepareMarkdownTextAnnotationsForCurrentLayout(
    annotations: PdfTextAnnotation[],
    savedPageWidth: number,
    savedPageHeight: number
  ): PdfTextAnnotation[] {
    const sourceWidth = Number.isFinite(savedPageWidth) && savedPageWidth > 0
      ? savedPageWidth
      : this.pageLogicalWidth;
    const sourceHeight = Number.isFinite(savedPageHeight) && savedPageHeight > 0
      ? savedPageHeight
      : this.pageLogicalHeight;

    return annotations.map((annotation) => ({
      ...annotation,
      pageNumber: 1,
      pageWidth: Number.isFinite(annotation.pageWidth) && annotation.pageWidth && annotation.pageWidth > 0
        ? annotation.pageWidth
        : sourceWidth,
      pageHeight: Number.isFinite(annotation.pageHeight) && annotation.pageHeight && annotation.pageHeight > 0
        ? annotation.pageHeight
        : sourceHeight,
      rects: annotation.rects.map((rect) => ({ ...rect }))
    }));
  }

  private renderMarkdownTextAnnotations(): void {
    const layer = this.markdownTextAnnotationLayerEl;
    if (!layer) return;

    layer.empty();
    if (this.standalone || this.isPdfPath(this.sourcePath) || !this.plugin.hasFeature("pdfTextAnnotation")) return;

    layer.style.width = `${Math.max(1, Math.ceil(this.pageLogicalWidth))}px`;
    layer.style.height = `${Math.max(1, Math.ceil(this.pageLogicalHeight))}px`;

    for (const annotation of this.pdfTextAnnotations) {
      if (annotation.kind === "note") continue;
      if (annotation.pageNumber !== 1) continue;

      for (let index = 0; index < annotation.rects.length; index++) {
        const rect = annotation.rects[index];
        const displayRect = this.getMarkdownAnnotationDisplayRect(annotation, rect);
        const el = layer.createDiv({
          cls: `mobile-ink-pdf-text-annotation mobile-ink-markdown-text-annotation mobile-ink-pdf-text-annotation-${annotation.kind}`
        });
        el.dataset.annotationId = annotation.id;
        el.dataset.annotationLabel = this.getPdfAnnotationLabel(annotation);
        el.style.left = `${displayRect.x}px`;
        el.style.width = `${displayRect.width}px`;
        el.style.backgroundColor = annotation.color;

        if (annotation.kind === "underline") {
          el.style.top = `${displayRect.y + Math.max(1, displayRect.height - 2)}px`;
          el.style.height = "2px";
        } else if (annotation.kind === "strikethrough") {
          el.style.top = `${displayRect.y + Math.max(1, Math.round(displayRect.height / 2) - 1)}px`;
          el.style.height = "2px";
        } else {
          el.style.top = `${displayRect.y}px`;
          el.style.height = `${displayRect.height}px`;
        }

        this.bindMarkdownAnnotationMenuTarget(el, annotation, displayRect);

      }
    }
  }

  private onSelectionContextMenu = (event: MouseEvent): void => {
    if (!this.strokeSelectMode || this.selectedStrokeIds.size === 0) return;

    const point = this.mouseEventToPagePoint(event);
    const selectedBounds = this.getSelectedStrokeBounds();
    if (!point || !selectedBounds || !this.pointInRect(point, this.inflateRect(selectedBounds, 6))) return;

    event.preventDefault();
    event.stopPropagation();
    this.showSelectionMenuAt(point);
  };

  private collectPdfTextLineRects(): PageRect[] {
    if (!this.backgroundEl) return [];

    const nodeFilter = window.NodeFilter ?? NodeFilter;
    const walker = document.createTreeWalker(this.backgroundEl, nodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.textContent ?? "";
        if (!text || text.trim().length === 0) return nodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || this.shouldSkipTextElement(parent)) return nodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) {
          return nodeFilter.FILTER_REJECT;
        }
        return nodeFilter.FILTER_ACCEPT;
      }
    });

    const rects: PageRect[] = [];
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      const range = document.createRange();
      try {
        range.selectNodeContents(textNode);
        for (const clientRect of Array.from(range.getClientRects())) {
          if (clientRect.width <= 0.2 || clientRect.height <= 0.2) continue;
          const rect = this.clientRectToPageRect(clientRect);
          if (!rect || rect.width <= 0.2 || rect.height <= 0.2) continue;
          rects.push(rect);
        }
      } finally {
        range.detach();
      }
      current = walker.nextNode();
    }

    return rects;
  }

  private hidePdfAnnotationMenu(): void {
    this.activePdfTextAnnotationId = null;
    if (this.pdfAnnotationMenuEl) {
      this.pdfAnnotationMenuEl.style.display = "none";
    }
  }

  private async copyActivePdfAnnotationText(): Promise<void> {
    const annotation = this.getActivePdfTextAnnotation();
    const text = annotation?.text || "";
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      new Notice("注釈の文字をコピーしました。");
    } catch {
      new Notice("コピーできませんでした。端末のコピーメニューを使ってください。");
    }
  }

  private updateActivePdfAnnotationColor(color: string): void {
    const annotation = this.getActivePdfTextAnnotation();
    if (!annotation) return;

    const annotationId = annotation.id;
    this.setPdfTextAnnotationColor(annotation.kind, color);

    let changed = false;
    this.pdfTextAnnotations = this.pdfTextAnnotations.map((annotation) => {
      if (annotation.id !== annotationId) return annotation;
      changed = normalizeCssColor(annotation.color) !== normalizeCssColor(color);
      return { ...annotation, color };
    });
    if (!changed) return;

    this.renderPdfTextAnnotations();
    this.syncPdfAnnotationColorChoices(color);
    this.saveQueue?.markDirty();
  }

  private getPdfAnnotationDisplayRect(annotation: PdfTextAnnotation, rect: PageRect, entry: PdfBackgroundPageEntry): PageRect {
    const targetWidth = Math.max(1, Math.ceil(entry.viewport.width));
    const targetHeight = Math.max(1, Math.ceil(entry.viewport.height));
    const sourceWidth = Number.isFinite(annotation.pageWidth) && annotation.pageWidth && annotation.pageWidth > 0
      ? annotation.pageWidth
      : targetWidth;
    const sourceHeight = Number.isFinite(annotation.pageHeight) && annotation.pageHeight && annotation.pageHeight > 0
      ? annotation.pageHeight
      : targetHeight;
    const scaleX = targetWidth / sourceWidth;
    const scaleY = targetHeight / sourceHeight;

    return {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    };
  }

  private getPdfAnnotationLabel(annotation: PdfTextAnnotation): string {
    return annotation.kind === "underline"
      ? "下線"
      : annotation.kind === "strikethrough"
        ? "取り消し線"
        : annotation.kind === "note"
          ? "注釈"
          : "ハイライト";
  }

  private bindPdfAnnotationMenuTarget(
    element: HTMLElement,
    annotation: PdfTextAnnotation,
    entry: PdfBackgroundPageEntry,
    rect: PageRect
  ): void {
    const open = (event: MouseEvent | PointerEvent) => {
      if (!this.selectMode) return;

      event.preventDefault();
      event.stopPropagation();
      this.showPdfAnnotationMenu(annotation.id, {
        x: rect.x + Math.min(rect.width, 96),
        y: entry.offsetY + Math.max(0, rect.y - 42)
      });
    };

    element.addEventListener("pointerdown", (event) => {
      if (!this.selectMode) return;
      event.preventDefault();
      event.stopPropagation();
    });
    element.addEventListener("click", open);
    element.addEventListener("contextmenu", open);
  }

  private renderMarkdownTextDragHighlights(rects: PdfTextSelectionRect[]): void {
    this.clearPdfTextDragHighlights();
    const layer = this.markdownTextAnnotationLayerEl;
    if (!layer) return;

    for (const rect of rects) {
      const highlight = layer.createDiv({ cls: "mobile-ink-pdf-text-selection-highlight mobile-ink-markdown-text-selection-highlight" });
      highlight.style.left = `${rect.x}px`;
      highlight.style.top = `${rect.y}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    }
  }

  private getMarkdownTextItems(): MarkdownTextLayerItem[] {
    if (this.markdownTextItems.length > 0) return this.markdownTextItems;
    const background = this.backgroundEl;
    if (!background) return [];

    const nodeFilter = window.NodeFilter ?? NodeFilter;
    const walker = document.createTreeWalker(background, nodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.textContent ?? "";
        if (!text || text.trim().length === 0) return nodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || this.shouldSkipTextElement(parent)) return nodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) {
          return nodeFilter.FILTER_REJECT;
        }
        return nodeFilter.FILTER_ACCEPT;
      }
    });

    const items: MarkdownTextLayerItem[] = [];
    const range = document.createRange();
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      const text = textNode.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (character === "\r") continue;
        if (character === "\n") {
          const last = items[items.length - 1];
          if (last) last.hasEOL = true;
          continue;
        }

        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const rect = this.getFirstUsefulClientRect(range.getClientRects());
        const pageRect = rect ? this.clientRectToPageRect(rect) : null;
        if (pageRect && pageRect.width > 0.2 && pageRect.height > 0.2) {
          items.push({
            index: items.length,
            pageNumber: 1,
            text: character,
            x: pageRect.x,
            y: pageRect.y,
            width: pageRect.width,
            height: pageRect.height
          });
        }
      }
      const last = items[items.length - 1];
      if (last) last.hasEOL = true;
      current = walker.nextNode();
    }
    range.detach();

    this.markdownTextItems = items;
    return items;
  }

  private getMarkdownTextLines(items: MarkdownTextLayerItem[]): Array<{ y: number; height: number; items: MarkdownTextLayerItem[] }> {
    const lines: Array<{ y: number; height: number; items: MarkdownTextLayerItem[] }> = [];

    for (const item of items) {
      const itemCenterY = item.y + item.height / 2;
      const line = lines.find((candidate) => {
        const lineCenterY = candidate.y + candidate.height / 2;
        return Math.abs(itemCenterY - lineCenterY) <= Math.max(4, Math.min(item.height, candidate.height) * 0.72);
      });

      if (line) {
        const bottom = Math.max(line.y + line.height, item.y + item.height);
        line.y = Math.min(line.y, item.y);
        line.height = Math.max(1, bottom - line.y);
        line.items.push(item);
        line.items.sort((a, b) => a.index - b.index);
      } else {
        lines.push({
          y: item.y,
          height: item.height,
          items: [item]
        });
      }
    }

    return lines.sort((a, b) => a.y - b.y);
  }

  private findMarkdownTextLineIndex(
    lines: Array<{ y: number; height: number; items: MarkdownTextLayerItem[] }>,
    point: PagePoint
  ): number {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const lineTop = line.y - Math.max(4, line.height * 0.45);
      const lineBottom = line.y + line.height + Math.max(4, line.height * 0.45);
      const distance = point.y < lineTop ? lineTop - point.y : point.y > lineBottom ? point.y - lineBottom : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  private getMarkdownTextFlowSelectionItems(
    lines: Array<{ y: number; height: number; items: MarkdownTextLayerItem[] }>,
    startLineIndex: number,
    startPoint: PagePoint,
    endLineIndex: number,
    endPoint: PagePoint
  ): MarkdownTextLayerItem[] {
    let fromLineIndex = startLineIndex;
    let toLineIndex = endLineIndex;
    let fromX = startPoint.x;
    let toX = endPoint.x;

    if (fromLineIndex > toLineIndex || (fromLineIndex === toLineIndex && fromX > toX)) {
      fromLineIndex = endLineIndex;
      toLineIndex = startLineIndex;
      fromX = endPoint.x;
      toX = startPoint.x;
    }

    const selected: MarkdownTextLayerItem[] = [];
    for (let lineIndex = fromLineIndex; lineIndex <= toLineIndex; lineIndex++) {
      const line = lines[lineIndex];
      if (!line) continue;

      selected.push(...line.items.filter((item) => {
        const centerX = item.x + item.width / 2;
        const right = item.x + item.width;
        const left = item.x;
        if (fromLineIndex === toLineIndex) return right >= fromX && left <= toX;
        if (lineIndex === fromLineIndex) return right >= fromX || centerX >= fromX;
        if (lineIndex === toLineIndex) return left <= toX || centerX <= toX;
        return true;
      }));
    }

    return selected.sort((a, b) => a.index - b.index);
  }

  private getMarkdownTextRectSelectionItems(items: MarkdownTextLayerItem[], drag: PdfTextDragSelectionState): MarkdownTextLayerItem[] {
    const x = Math.min(drag.start.x, drag.current.x);
    const y = Math.min(drag.start.y, drag.current.y);
    const width = Math.abs(drag.current.x - drag.start.x);
    const height = Math.abs(drag.current.y - drag.start.y);
    const rect = { x, y, width: Math.max(1, width), height: Math.max(1, height) };

    return items
      .filter((item) => this.rectsIntersect(item, rect)
        || this.pointInRect({ x: item.x + item.width / 2, y: item.y + item.height / 2 }, rect))
      .sort((a, b) => a.index - b.index);
  }

  private findMarkdownTextItemAt(point: PagePoint): MarkdownTextLayerItem | null {
    const items = this.getMarkdownTextItems();
    let nearest: { item: MarkdownTextLayerItem; distance: number } | null = null;

    for (const item of items) {
      const hitRect = this.inflateRect(item, Math.max(3, item.height * 0.28));
      if (this.pointInRect(point, hitRect)) return item;

      const centerX = item.x + item.width / 2;
      const centerY = item.y + item.height / 2;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const distance = dx * dx + dy * dy;
      if (!nearest || distance < nearest.distance) {
        nearest = { item, distance };
      }
    }

    if (!nearest) return null;
    const maxDistance = Math.max(18, nearest.item.height * 1.4);
    return nearest.distance <= maxDistance * maxDistance ? nearest.item : null;
  }

  private getPdfAnnotationFirstDisplayRect(annotation: PdfTextAnnotation): PageRect | null {
    const rect = annotation.rects[0];
    if (!rect) return null;

    if (!this.isPdfPath(this.sourcePath)) {
      return this.getMarkdownAnnotationDisplayRect(annotation, rect);
    }

    const entry = this.pdfBackgroundPages.find((page) => page.pageNumber === annotation.pageNumber);
    if (!entry) return rect;
    return this.getPdfAnnotationDisplayRect(annotation, rect, entry);
  }

  private showPdfAnnotationMenu(annotationId: string, point: PagePoint): void {
    const menu = this.pdfAnnotationMenuEl;
    const annotation = this.pdfTextAnnotations.find((item) => item.id === annotationId);
    if (!menu || !annotation) return;

    this.activePdfTextAnnotationId = annotationId;
    this.hidePdfTextMenu();
    document.getSelection()?.removeAllRanges();

    const summary = menu.querySelector<HTMLElement>(".mobile-ink-pdf-annotation-menu-summary");
    if (summary) {
      summary.empty();
      summary.createDiv({
        cls: "mobile-ink-pdf-annotation-kind",
        text: this.getPdfAnnotationLabel(annotation)
      });
      const previewText = annotation.text;
      if (previewText) {
        summary.createDiv({
          cls: "mobile-ink-pdf-annotation-preview",
          text: previewText
        });
      }
    }
    this.syncPdfAnnotationColorChoices(annotation.color);

    menu.style.display = "flex";
    menu.style.left = `${point.x}px`;
    menu.style.top = `${point.y}px`;

    requestAnimationFrame(() => {
      if (!this.pdfAnnotationMenuEl) return;

      const menuWidth = this.pdfAnnotationMenuEl.offsetWidth || 240;
      const menuHeight = this.pdfAnnotationMenuEl.offsetHeight || 80;
      const left = Math.min(Math.max(point.x, 6), Math.max(6, this.pageLogicalWidth - menuWidth - 6));
      const top = Math.min(Math.max(point.y, 6), Math.max(6, this.pageLogicalHeight - menuHeight - 6));
      this.pdfAnnotationMenuEl.style.left = `${left}px`;
      this.pdfAnnotationMenuEl.style.top = `${top}px`;
    });
  }

  private syncPdfAnnotationColorChoices(color: string): void {
    const menu = this.pdfAnnotationMenuEl;
    if (!menu) return;

    for (const button of Array.from(menu.querySelectorAll<HTMLElement>(".mobile-ink-pdf-color-choice"))) {
      button.classList.toggle("mobile-ink-active", normalizeCssColor(button.dataset.color ?? "") === normalizeCssColor(color));
    }
  }
}

function multiplyPdfMatrix(a: PdfMatrix, b: PdfMatrix): PdfMatrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function normalizeCssColor(color: string): string {
  return color.trim().toLowerCase().replace(/\s+/g, "");
}

function mergePdfSelectionRects(rects: PdfTextSelectionRect[]): PdfTextSelectionRect[] {
  const sorted = [...rects].sort((a, b) => a.pageNumber - b.pageNumber || a.y - b.y || a.x - b.x);
  const merged: PdfTextSelectionRect[] = [];

  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    const sameLine = last
      && last.pageNumber === rect.pageNumber
      && Math.abs(last.y - rect.y) <= Math.max(2, Math.min(last.height, rect.height) * 0.35)
      && Math.abs(last.height - rect.height) <= Math.max(3, Math.max(last.height, rect.height) * 0.45)
      && rect.x <= last.x + last.width + 4;

    if (sameLine) {
      const right = Math.max(last.x + last.width, rect.x + rect.width);
      const bottom = Math.max(last.y + last.height, rect.y + rect.height);
      last.x = Math.min(last.x, rect.x);
      last.y = Math.min(last.y, rect.y);
      last.width = right - last.x;
      last.height = bottom - last.y;
      continue;
    }

    merged.push({ ...rect });
  }

  return merged;
}
