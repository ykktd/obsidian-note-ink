import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { StrokeStore } from "./ink/StrokeStore";
import { AnnotationView } from "./views/AnnotationView";
import { VIEW_TYPE_MOBILE_INK } from "./constants";

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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new StrokeStore(this.app, this);

    this.registerView(
      VIEW_TYPE_MOBILE_INK,
      (leaf) => new AnnotationView(leaf, this)
    );

    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      this.queueOpenPdfWithAnnotationByDefault(file);
    }));

    this.addSettingTab(new MobileInkAnnotationSettingTab(this.app, this));

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
        const file = this.app.workspace.getActiveFile();
        const canRun = !!view && file instanceof TFile && file.extension === "pdf";
        if (!checking && canRun) void view!.exportPdfCopy();
        return canRun;
      }
    });
  }

  onunload(): void {
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

  async openSourceWithoutAnnotation(file:TFile,leaf:WorkspaceLeaf):Promise<void> {
    this.sourceViewLeaves.set(leaf,file.path);
    try {await leaf.setViewState({type:file.extension==='pdf' ? 'pdf' : 'markdown',active:true,state:{file:file.path}});}
    catch(error){this.sourceViewLeaves.delete(leaf);throw error;}
  }

  private async openPdfWithAnnotationByDefaultIfNeeded(file: TFile | null): Promise<void> {
    if (!this.settings.openPdfWithAnnotationByDefault) return;
    if (!(file instanceof TFile) || file.extension !== "pdf") return;
    if (this.defaultPdfOpenPath === file.path) return;

    const leaf = this.app.workspace.activeLeaf;
    if (!leaf) return;
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

    if (viewState.type === VIEW_TYPE_MOBILE_INK && statePath === file.path) return;

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
