import { App, Plugin, TFile } from "obsidian";
import { AnnotationFile, InkStroke, MarkdownLayoutSnapshot, PdfTextAnnotation, StandaloneElement, StandalonePage } from "./types";
import { stableHash } from "../utils/hash";
import { stringifyJsonOffMainThread } from "../utils/jsonWorker";

export class StrokeStore {
  private readonly baseDir: string;

  constructor(
    private readonly app: App,
    private readonly plugin: Plugin
  ) {
    const pluginDir = plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
    this.baseDir = `${pluginDir}/annotations`;
  }

  async load(sourcePath: string, pageWidth: number, pageHeight: number): Promise<AnnotationFile> {
    await this.ensureBaseDir();
    const path = this.getAnnotationPath(sourcePath);
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    const sourceMtime = file instanceof TFile ? file.stat.mtime : 0;

    if (!(await this.app.vault.adapter.exists(path))) {
      return this.createEmpty(sourcePath, sourceMtime, pageWidth, pageHeight);
    }

    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as AnnotationFile;
      return {
        version: 1,
        sourcePath,
        sourceMtime: parsed.sourceMtime ?? sourceMtime,
        pageWidth: parsed.pageWidth ?? pageWidth,
        pageHeight: parsed.pageHeight ?? pageHeight,
        strokes: Array.isArray(parsed.strokes) ? sanitizeStrokes(parsed.strokes) : [],
        markdownLayout: sanitizeMarkdownLayout(parsed.markdownLayout),
        pdfTextAnnotations: Array.isArray(parsed.pdfTextAnnotations) ? sanitizePdfTextAnnotations(parsed.pdfTextAnnotations) : [],
        updatedAt: parsed.updatedAt ?? Date.now()
      };
    } catch (error) {
      console.error("Note Ink: failed to read annotation file", error);
      throw new Error("保存済みの注釈を読み込めません。上書きを防ぐため、ファイルを開くのを中止しました。");
    }
  }

  async save(annotation: AnnotationFile): Promise<void> {
    await this.ensureBaseDir();
    const path = this.getAnnotationPath(annotation.sourcePath);
    const payload: AnnotationFile = {
      ...annotation,
      version: 1,
      updatedAt: Date.now(),
      strokes: annotation.strokes,
      markdownLayout: sanitizeMarkdownLayout(annotation.markdownLayout),
      pdfTextAnnotations: sanitizePdfTextAnnotations(annotation.pdfTextAnnotations ?? [])
    };
    await this.app.vault.adapter.write(path, await stringifyJsonOffMainThread(payload, 2));
  }

  async loadStandalone(path: string, pageWidth: number, pageHeight: number): Promise<AnnotationFile> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) && !(await this.app.vault.adapter.exists(path))) {
      return this.createEmpty(path, 0, pageWidth, pageHeight);
    }

    try {
      const raw = file instanceof TFile
        ? await this.app.vault.read(file)
        : await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as AnnotationFile;
      const legacyStrokes = Array.isArray(parsed.strokes) ? sanitizeStrokes(parsed.strokes) : [];
      
      // Migrate legacy single-page format to multi-page format
      let pages: StandalonePage[];
      if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
        pages = parsed.pages.map((p, i) => ({
          pageNumber: typeof p.pageNumber === "number" ? p.pageNumber : i + 1,
          strokes: Array.isArray(p.strokes) ? sanitizeStrokes(p.strokes) : []
        }));
      } else {
        // Migrate: wrap legacy strokes as page 1
        pages = [{ pageNumber: 1, strokes: legacyStrokes }];
      }

      return {
        version: 1,
        sourcePath: path,
        sourceMtime: parsed.sourceMtime ?? 0,
        pageWidth: Number.isFinite(parsed.pageWidth) && parsed.pageWidth > 0 ? parsed.pageWidth : pageWidth,
        pageHeight: Number.isFinite(parsed.pageHeight) && parsed.pageHeight > 0 ? parsed.pageHeight : pageHeight,
        strokes: legacyStrokes,
        markdownLayout: sanitizeMarkdownLayout(parsed.markdownLayout),
        pdfTextAnnotations: Array.isArray(parsed.pdfTextAnnotations) ? sanitizePdfTextAnnotations(parsed.pdfTextAnnotations) : [],
        template: parsed.template,
        pages,
        elements: Array.isArray(parsed.elements) ? sanitizeStandaloneElements(parsed.elements) : [],
        updatedAt: parsed.updatedAt ?? Date.now()
      };
    } catch (error) {
      console.error("Note Ink: failed to read standalone ink file", error);
      return this.createEmpty(path, 0, pageWidth, pageHeight);
    }
  }

  async saveStandalone(annotation: AnnotationFile, isPluginDir = false): Promise<TFile | null> {
    await this.ensureVaultFolderForPath(annotation.sourcePath);
    const payload: AnnotationFile = {
      ...annotation,
      version: 1,
      updatedAt: Date.now(),
      strokes: annotation.strokes,
      markdownLayout: sanitizeMarkdownLayout(annotation.markdownLayout),
      pdfTextAnnotations: sanitizePdfTextAnnotations(annotation.pdfTextAnnotations ?? []),
      elements: sanitizeStandaloneElements(annotation.elements ?? [])
    };
    const data = await stringifyJsonOffMainThread(payload, 2);
    const existing = this.app.vault.getAbstractFileByPath(annotation.sourcePath);

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, data);
      return existing;
    }

    if (existing) {
      throw new Error(`Cannot save standalone ink note over a folder: ${annotation.sourcePath}`);
    }

    // For plugin-directory paths, skip vault.create() and go straight to adapter.write().
    if (isPluginDir) {
      const folder = annotation.sourcePath.split("/").slice(0, -1).join("/");
      if (folder) await this.ensureAdapterFolder(folder);
      await this.app.vault.adapter.write(annotation.sourcePath, data);
      return null; // Plugin-dir files won't be in vault index.
    }

    // Primary: vault.create() — keeps vault index consistent.
    // Fallback: vault.adapter.write() — bypasses iCloud document coordination which
    // can reject vault.create() on iOS with a permission error for certain paths.
    try {
      return await this.app.vault.create(annotation.sourcePath, data);
    } catch {
      // Explicitly ensure the physical directory exists before adapter.write()
      // in case vault.createFolder() only updated the in-memory index.
      const physicalFolder = annotation.sourcePath.split("/").slice(0, -1).join("/");
      if (physicalFolder) {
        await this.ensureAdapterFolder(physicalFolder);
      }
      await this.app.vault.adapter.write(annotation.sourcePath, data);

      // Poll for the vault file-watcher to index the newly written file.
      // On iOS with iCloud this can take several seconds.
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
        const indexed = this.app.vault.getAbstractFileByPath(annotation.sourcePath);
        if (indexed instanceof TFile) return indexed;
      }

      // File is on disk but vault hasn't indexed it yet; return null so the
      // caller can open the view by path instead of by TFile.
      return null;
    }
  }

  getAnnotationPath(sourcePath: string): string {
    const hash = stableHash(sourcePath);
    const safeName = sourcePath
      .split("/")
      .pop()
      ?.replace(/[^\w\-.\u4e00-\u9fa5]/g, "_") ?? "note";
    return `${this.baseDir}/${safeName}.${hash}.ink.json`;
  }

  private createEmpty(sourcePath: string, sourceMtime: number, pageWidth: number, pageHeight: number): AnnotationFile {
    return {
      version: 1,
      sourcePath,
      sourceMtime,
      pageWidth,
      pageHeight,
      strokes: [],
      template: "blank",
      pages: [{ pageNumber: 1, strokes: [] }],
      elements: [],
      pdfTextAnnotations: [],
      updatedAt: Date.now()
    };
  }

  private async ensureBaseDir(): Promise<void> {
    await this.ensureAdapterFolder(this.baseDir);
  }

  async ensureFolder(path: string): Promise<void> {
    await this.ensureVaultFolder(path);
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`Cannot create folder because a file already exists: ${current}`);
      }
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async ensureVaultFolderForPath(path: string): Promise<void> {
    const folder = path.split("/").slice(0, -1).join("/");
    if (!folder) return;
    // Run both: vault API keeps the vault index consistent,
    // adapter.mkdir() ensures the physical directory exists on iOS
    // (vault.createFolder may only update the in-memory index without creating the directory).
    await Promise.allSettled([
      this.ensureVaultFolder(folder),
      this.ensureAdapterFolder(folder)
    ]);
  }

  private async ensureAdapterFolder(path: string): Promise<void> {
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

}

function sanitizeMarkdownLayout(layout: MarkdownLayoutSnapshot | undefined): MarkdownLayoutSnapshot | undefined {
  if (!layout || !Array.isArray(layout.anchors)) return undefined;

  const pageWidth = Number.isFinite(layout.pageWidth) && layout.pageWidth > 0
    ? layout.pageWidth
    : 0;
  const pageHeight = Number.isFinite(layout.pageHeight) && layout.pageHeight > 0
    ? layout.pageHeight
    : 0;
  const anchors = layout.anchors
    .filter((anchor) => anchor
      && typeof anchor.key === "string"
      && anchor.key.length > 0
      && Number.isFinite(anchor.y)
      && Number.isFinite(anchor.height)
      && anchor.height > 0)
    .map((anchor) => ({
      key: anchor.key,
      y: anchor.y,
      height: anchor.height
    }));

  if (pageWidth <= 0 || pageHeight <= 0 || anchors.length === 0) return undefined;

  return {
    version: 1,
    sourceHash: typeof layout.sourceHash === "string" && layout.sourceHash.length > 0 ? layout.sourceHash : undefined,
    pageWidth,
    pageHeight,
    anchors
  };
}

function sanitizePdfTextAnnotations(annotations: PdfTextAnnotation[]): PdfTextAnnotation[] {
  return annotations
    .filter((annotation) => annotation && Array.isArray(annotation.rects) && annotation.rects.length > 0)
    .map((annotation): PdfTextAnnotation => {
      const kind = annotation.kind === "underline" || annotation.kind === "strikethrough" || annotation.kind === "note" ? annotation.kind : "highlight";
      const pageWidth = Number.isFinite(annotation.pageWidth) && annotation.pageWidth !== undefined && annotation.pageWidth > 0
        ? annotation.pageWidth
        : undefined;
      const pageHeight = Number.isFinite(annotation.pageHeight) && annotation.pageHeight !== undefined && annotation.pageHeight > 0
        ? annotation.pageHeight
        : undefined;
      return {
        id: String(annotation.id || crypto.randomUUID()),
        kind,
        pageNumber: Number.isFinite(annotation.pageNumber) && annotation.pageNumber > 0 ? Math.floor(annotation.pageNumber) : 1,
        pageWidth,
        pageHeight,
        color: typeof annotation.color === "string" ? annotation.color : "#ffd54a",
        text: typeof annotation.text === "string" ? annotation.text : "",
        rects: annotation.rects
          .filter((rect) => rect
            && Number.isFinite(rect.x)
            && Number.isFinite(rect.y)
            && Number.isFinite(rect.width)
            && Number.isFinite(rect.height)
            && rect.width > 0
            && rect.height > 0)
          .map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          })),
        note: typeof annotation.note === "string" ? annotation.note : undefined,
        createdAt: Number.isFinite(annotation.createdAt) ? annotation.createdAt : Date.now()
      };
    })
    .filter((annotation) => annotation.rects.length > 0);
}

function sanitizeStrokes(strokes: InkStroke[]): InkStroke[] {
  return strokes
    .filter((stroke) => stroke && Array.isArray(stroke.points) && stroke.points.length > 0)
    .map((stroke) => ({
      id: String(stroke.id || crypto.randomUUID()),
      tool: stroke.tool === "highlighter" ? "highlighter" : "pen",
      color: typeof stroke.color === "string" ? stroke.color : "#111111",
      width: Number.isFinite(stroke.width) ? stroke.width : 2,
      points: stroke.points
        .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        .map((point) => ({
          x: point.x,
          y: point.y,
          t: Number.isFinite(point.t) ? point.t : Date.now(),
          pressure: Number.isFinite(point.pressure) ? point.pressure : 0.5,
          tiltX: Number.isFinite(point.tiltX) ? point.tiltX : undefined,
          tiltY: Number.isFinite(point.tiltY) ? point.tiltY : undefined
        }))
    }));
}

function sanitizeStandaloneElements(elements: StandaloneElement[]): StandaloneElement[] {
  return elements
    .map((element): StandaloneElement | null => {
      if (!element) return null;

      const base = {
        id: String(element.id || crypto.randomUUID()),
        pageNumber: Number.isFinite(element.pageNumber) && element.pageNumber > 0 ? Math.floor(element.pageNumber) : 1,
        x: Number.isFinite(element.x) ? element.x : 24,
        y: Number.isFinite(element.y) ? element.y : 24,
        width: Number.isFinite(element.width) && element.width > 0 ? element.width : 180,
        height: Number.isFinite(element.height) && element.height > 0 ? element.height : 120,
        rotation: Number.isFinite(element.rotation) ? element.rotation : 0,
        zIndex: Number.isFinite(element.zIndex) ? element.zIndex : 0,
        locked: element.locked === true
      };

      if (element.type === "image" && typeof element.sourcePath === "string" && element.sourcePath.length > 0) {
        return {
          ...base,
          type: "image",
          sourcePath: element.sourcePath,
          opacity: Number.isFinite(element.opacity) && element.opacity !== undefined ? Math.min(1, Math.max(0, element.opacity)) : 1
        };
      }

      if (element.type === "shape") {
        const shape = ["rect", "ellipse", "line", "note"].includes(element.shape) ? element.shape : "rect";
        return {
          ...base,
          type: "shape",
          shape,
          fill: typeof element.fill === "string" ? element.fill : "rgba(255,255,255,0.72)",
          stroke: typeof element.stroke === "string" ? element.stroke : "#8fb36d",
          strokeWidth: Number.isFinite(element.strokeWidth) && element.strokeWidth !== undefined ? Math.max(0, element.strokeWidth) : 2,
          opacity: Number.isFinite(element.opacity) && element.opacity !== undefined ? Math.min(1, Math.max(0, element.opacity)) : 1,
          borderRadius: Number.isFinite(element.borderRadius) && element.borderRadius !== undefined ? Math.max(0, element.borderRadius) : 8
        };
      }

      if (element.type === "sticker") {
        const stickers = [
          "tape-blue", "tape-green", "tape-yellow", "flower", "paperclip", "sticky-note",
          "emoji-smile", "emoji-laugh", "emoji-wink", "emoji-heart-eyes", "emoji-surprised",
          "emoji-thinking", "emoji-sad", "emoji-party", "emoji-sparkles", "emoji-sun",
          "icon-heart", "icon-star"
        ];
        const sticker = stickers.includes(element.sticker) ? element.sticker : "emoji-smile";
        return {
          ...base,
          type: "sticker",
          sticker,
          opacity: Number.isFinite(element.opacity) && element.opacity !== undefined ? Math.min(1, Math.max(0, element.opacity)) : 1,
          text: typeof element.text === "string" ? element.text.slice(0, 12) : undefined
        };
      }

      return null;
    })
    .filter((element): element is StandaloneElement => element !== null);
}
