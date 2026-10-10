import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { StrokeStore } from "./ink/StrokeStore";
import { AnnotationView } from "./views/AnnotationView";
import { VIEW_TYPE_MOBILE_INK } from "./constants";
import { NativePdfAnnotationSession } from "./pdf/NativePdfAnnotationSession";

type MobileInkAnnotationSettings = {
  openPdfWithAnnotationByDefault: boolean;
};

const DEFAULT_SETTINGS: MobileInkAnnotationSettings = {
  openPdfWithAnnotationByDefault: false
};

export default class MobileInkAnnotationPlugin extends Plugin {
  store!: StrokeStore;
  settings!: MobileInkAnnotationSettings;
  private defaultPdfOpenPath: string | null = null;
  private readonly sourceViewLeaves = new WeakMap<WorkspaceLeaf,string>();
  private readonly pdfSessions = new Map<WorkspaceLeaf,NativePdfAnnotationSession>();
  private pdfOpening:Promise<void>=Promise.resolve();
  private unloading=false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new StrokeStore(this.app, this);

    this.registerView(
      VIEW_TYPE_MOBILE_INK,
      (leaf) => new AnnotationView(leaf, this)
    );

    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      this.cleanPdfSessions();
      this.queueOpenPdfWithAnnotationByDefault(file);
    }));
    this.registerEvent(this.app.workspace.on("layout-change",()=>this.cleanPdfSessions()));

    this.addSettingTab(new MobileInkAnnotationSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(()=>{
      for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOBILE_INK)){
        const state=leaf.getViewState().state as {sourcePath?:string;file?:string}|undefined;
        const file=this.app.vault.getAbstractFileByPath(state?.sourcePath??state?.file??"");
        if(file instanceof TFile&&file.extension==="pdf")void this.openInkForFile(file,leaf).catch(error=>console.error("Note Ink: PDF restore failed",error));
      }
    });

    this.addRibbonIcon("pencil", "手書き注釈を開く", async () => {
      await this.openInkForActiveFile();
    });

    this.addCommand({
      id: "open-mobile-ink-annotation",
      name: "現在のファイルに手書き注釈を付ける",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canRun = file instanceof TFile && (file.extension === "md" || file.extension === "pdf");
        if (checking) return canRun;
        if (canRun && file) {
          void this.openInkForFile(file);
        }
        return true;
      }
    });
    this.addCommand({
      id: "export-annotated-pdf",
      name: "書き込み入りPDFを書き出す",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(AnnotationView);
        const session=this.pdfSessions.get(this.app.workspace.activeLeaf!);
        const file = this.app.workspace.getActiveFile();
        const canRun = (!!view||!!session&&!session.closed) && file instanceof TFile && file.extension === "pdf";
        if (!checking && canRun) void (session&&!session.closed?session.exportPdfCopy():view!.exportPdfCopy());
        return canRun;
      }
    });
  }

  onunload(): void {
    this.unloading=true;
    for(const session of this.pdfSessions.values())session.unload();
    this.pdfSessions.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MOBILE_INK);
  }

  async openInkForActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("まずMarkdownノートまたはPDFを開いてください。");
      return;
    }

    if (file.extension !== "md" && file.extension !== "pdf") {
      new Notice("注釈を付けられるのはMarkdownノートとPDFです。");
      return;
    }

    await this.openInkForFile(file);
  }

  async openInkForFile(file: TFile, leaf: WorkspaceLeaf = this.app.workspace.getLeaf(true)): Promise<void> {
    this.sourceViewLeaves.delete(leaf);
    if(file.extension==="pdf"){
      const task=this.pdfOpening.catch(()=>{}).then(()=>this.openNativePdfAnnotation(file,leaf));
      this.pdfOpening=task;return task;
    }
    await leaf.setViewState({
      type: VIEW_TYPE_MOBILE_INK,
      active: true,
      state: {
        file: file.path,
        sourcePath: file.path
      }
    });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openNativePdfAnnotation(file:TFile,leaf:WorkspaceLeaf):Promise<void>{
    if(this.unloading)return;
    const current=this.pdfSessions.get(leaf);
    if(current&&!current.closed&&current.sourcePath===file.path&&leaf.view===current.binding.view){this.app.workspace.revealLeaf(leaf);return;}
    // Keep one editable session per PDF; other tabs continue to use normal PDF viewing.
    for(const [other,session]of this.pdfSessions)if(other===leaf||session.sourcePath===file.path){await session.close();this.pdfSessions.delete(other);}
    if(leaf.view?.getViewType()!=="pdf"||(leaf.view as any).file?.path!==file.path)await leaf.setViewState({type:"pdf",active:true,state:{file:file.path}});
    this.app.workspace.revealLeaf(leaf);
    try{
      const session=await NativePdfAnnotationSession.open(this.app,this.store,leaf,file.path);
      if(this.unloading){await session.close();return;}this.pdfSessions.set(leaf,session);
    }catch(error){console.error("Note Ink: native PDF annotation unavailable",error);new Notice(error instanceof Error?error.message:"注釈を開けませんでした。通常のPDF表示はそのまま使えます。",10000);}
  }
  private cleanPdfSessions():void{
    for(const [leaf,session]of this.pdfSessions){
      if(session.closed){this.pdfSessions.delete(leaf);continue;}
      if(leaf.view!==session.binding.view||(leaf.view as any).file?.path!==session.sourcePath)void session.close().then(()=>this.pdfSessions.delete(leaf)).catch(error=>console.error("Note Ink: PDF close failed",error));
    }
  }

  async openSourceWithoutAnnotation(file:TFile,leaf:WorkspaceLeaf):Promise<void> {
    this.sourceViewLeaves.set(leaf,file.path);
    const session=this.pdfSessions.get(leaf);if(session){await session.close();this.pdfSessions.delete(leaf);}
    try {await leaf.setViewState({type:file.extension==='pdf' ? 'pdf' : 'markdown',active:true,state:{file:file.path}});}
    catch(error){this.sourceViewLeaves.delete(leaf);throw error;}
  }

  private async openPdfWithAnnotationByDefaultIfNeeded(file: TFile | null): Promise<void> {
    if (!this.settings.openPdfWithAnnotationByDefault) return;
    if (!(file instanceof TFile) || file.extension !== "pdf") return;
    if (this.defaultPdfOpenPath === file.path) return;

    const leaf = this.app.workspace.activeLeaf;
    if (!leaf) return;
    const session=this.pdfSessions.get(leaf);if(session&&!session.closed&&session.sourcePath===file.path)return;
    const sourceViewPath=this.sourceViewLeaves.get(leaf);
    if(sourceViewPath===file.path)return;
    if(sourceViewPath)this.sourceViewLeaves.delete(leaf);

    const viewState = leaf.getViewState();
    const state = (viewState.state ?? {}) as { file?: unknown; sourcePath?: unknown };
    const statePath = typeof state.sourcePath === "string"
      ? state.sourcePath
      : typeof state.file === "string"
        ? state.file
        : "";
    const activeFile = this.app.workspace.getActiveFile();
    const activePath = activeFile instanceof TFile ? activeFile.path : "";
    const leafFile = (leaf.view as { file?: unknown }).file;
    const leafFilePath = leafFile instanceof TFile ? leafFile.path : "";

    const leafLooksRelatedToFile = activePath === file.path
      || leafFilePath === file.path
      || statePath === file.path
      || viewState.type === VIEW_TYPE_MOBILE_INK;
    if (!leafLooksRelatedToFile) return;

    this.defaultPdfOpenPath = file.path;
    try {
      await this.openInkForFile(file, leaf);
    } finally {
      window.setTimeout(() => {
        if (this.defaultPdfOpenPath === file.path) {
          this.defaultPdfOpenPath = null;
        }
      }, 0);
    }
  }

  private queueOpenPdfWithAnnotationByDefault(file: TFile | null): void {
    if (!(file instanceof TFile) || file.extension !== "pdf") return;

    for (const delay of [0, 80, 240]) {
      window.setTimeout(() => {
        void this.openPdfWithAnnotationByDefaultIfNeeded(file);
      }, delay);
    }
  }

  openActivePdfWithAnnotationIfEnabled(): void {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "pdf") return;

    void this.openPdfWithAnnotationByDefaultIfNeeded(file);
  }

  /** 本版本不区分基础版/进阶版，所有功能门禁一律放行。 */
  hasFeature(_feature: string): boolean {
    return true;
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class MobileInkAnnotationSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: MobileInkAnnotationPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("PDFを注釈画面で開く")
      .setDesc("PDFを開くと、保存済みの手書きやハイライトを表示する注釈画面に切り替えます。オフの場合はObsidian標準のPDFビューアーで開きます。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openPdfWithAnnotationByDefault)
          .onChange(async (value) => {
            this.plugin.settings.openPdfWithAnnotationByDefault = value;
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.openActivePdfWithAnnotationIfEnabled();
              new Notice("PDFを注釈画面で開くように設定しました。");
            } else {
              new Notice("PDFはObsidian標準のビューアーで開きます。");
            }
          });
      });
  }
}
