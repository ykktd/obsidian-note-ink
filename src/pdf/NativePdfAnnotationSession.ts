import { Menu, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { FloatingInkToolbar } from "../ui/FloatingInkToolbar";
import { SaveQueue } from "../ink/SaveQueue";
import type { StrokeStore } from "../ink/StrokeStore";
import type { InkTool, PdfTextAnnotation } from "../ink/types";
import { NativePdfLasso } from "./NativePdfLasso";
import { NativePdfInkController } from "./NativePdfInkController";
import { connectNativePdf, type NativePdfBinding } from "./NativePdfViewer";
import { invertMatrix, transformPoint } from "./exportAnnotatedPdf";
import { exportNativePdf } from "./exportNativePdf";
import { saveExportCopy } from "./saveExportCopy";

export class NativePdfAnnotationSession {
  readonly controller:NativePdfInkController;
  private raw:string|null;
  private queue:SaveQueue;
  private tools:HTMLElement;
  private floatingToolbar:FloatingInkToolbar;
  private buttons=new Map<string,HTMLButtonElement>();
  private lassoMode=false;
  private lasso:NativePdfLasso;
  private drawingTool:InkTool="pen";
  private width:HTMLInputElement;
  private color:HTMLInputElement;
  private widthValue:HTMLOutputElement;
  private eraserModes:HTMLElement;
  private errorEl:HTMLElement|null=null;
  private actions:HTMLElement[]=[];
  private disposed=false;
  private closing:Promise<void>|null=null;
  private exporting=false;
  private readonly doc:Document;
  private readonly originalUnload:any;
  private readonly originalClose:any;
  private unloadHook:any;
  private closeHook:any;

  static async open(app:App,store:StrokeStore,leaf:WorkspaceLeaf,path:string,onClosed=()=>{}):Promise<NativePdfAnnotationSession>{
    const binding=await connectNativePdf(leaf,path),loaded=await store.loadPdf(path,binding.pdf);
    if(leaf.view!==binding.view||binding.view.file?.path!==path||binding.viewer.pdfDocument!==binding.pdf)throw new Error("表示するPDFが変わりました。もう一度、手書きを始めてください。");
    return new NativePdfAnnotationSession(app,store,leaf,binding,loaded,onClosed);
  }
  private constructor(private app:App,private store:StrokeStore,readonly leaf:WorkspaceLeaf,readonly binding:NativePdfBinding,loaded:Awaited<ReturnType<StrokeStore["loadPdf"]>>,private onClosed:()=>void){
    this.raw=loaded.raw;this.doc=binding.viewer.container.ownerDocument;
    this.queue=new SaveQueue(async()=>{this.controller.flushPendingStrokes();this.raw=await store.savePdf(this.controller.annotation,this.raw);},800,
      error=>this.showError(error),()=>{this.errorEl?.remove();this.errorEl=null;});
    this.controller=new NativePdfInkController(binding,loaded.annotation,{onChange:()=>{this.queue.markDirty();this.lasso?.refresh();this.refresh();},
      onInputStart:()=>this.queue.setPaused(true),onInputEnd:()=>{this.queue.setPaused(false);this.refresh();},
      onDocumentChanged:()=>{void this.close().then(()=>new Notice("PDFが更新されたため、手書きを終了しました。もう一度、手書きを始めてください。")).catch(error=>this.showError(error));}});
    const content=binding.view.contentEl as HTMLElement;content.classList.add("note-ink-native-host");
    this.tools=this.doc.createElement("div");this.tools.className="mobile-ink-toolbar note-ink-native-tools";this.tools.setAttribute("aria-label","手書きツールバー");
    const dock=this.doc.createElement("div");dock.className="mobile-ink-toolbar-dock";this.tools.append(dock);content.append(this.tools);
    const button=(key:string,icon:string,label:string,action:()=>void)=>{
      const b=this.doc.createElement("button");b.type="button";b.className="mobile-ink-icon-button";b.setAttribute("aria-label",label);b.title=label;setIcon(b,icon);b.addEventListener("click",action);dock.append(b);this.buttons.set(key,b);return b;
    };
    button("pen","pencil","ペン",()=>this.setTool("pen"));button("highlighter","highlighter","蛍光ペン",()=>this.setTool("highlighter"));button("eraser","eraser","消しゴム",()=>this.setTool("eraser"));
    button("lasso","lasso-select","投げ縄選択",()=>{this.controller.flushPendingStrokes();this.lassoMode=true;this.controller.setInputEnabled(false);this.lasso.setEnabled(true);this.refresh();});
    this.color=this.doc.createElement("input");this.color.type="color";this.color.setAttribute("aria-label","色");this.color.title="色";this.color.addEventListener("input",()=>{const state=this.controller.getToolState();this.controller.setToolState(state.tool==="highlighter"?{highlighterColor:this.color.value}:{color:this.color.value});});dock.append(this.color);
    const widthLabel=this.doc.createElement("label");widthLabel.className="note-ink-native-width";widthLabel.append("太さ");this.width=this.doc.createElement("input");this.width.type="range";this.width.min=".5";this.width.max="72";this.width.step=".5";this.width.setAttribute("aria-label","太さ");this.widthValue=this.doc.createElement("output");widthLabel.append(this.width,this.widthValue);dock.append(widthLabel);
    this.width.addEventListener("input",()=>{const value=Number(this.width.value),state=this.controller.getToolState();if(!Number.isFinite(value)||value<.5||value>72){this.refresh();return;}this.controller.setToolState(state.tool==="eraser"?{eraserRadius:value}:state.tool==="highlighter"?{highlighterWidth:value}:{width:value});this.refresh();});
    this.eraserModes=this.doc.createElement("div");this.eraserModes.className="note-ink-eraser-modes";
    this.eraserModes.setAttribute("role","radiogroup");
    const heading=this.doc.createElement("div");heading.className="note-ink-eraser-heading";heading.id=`eraser-heading-${crypto.randomUUID()}`;heading.textContent="消しゴム";
    this.eraserModes.setAttribute("aria-labelledby",heading.id);this.eraserModes.append(heading);
    const group=`eraser-${crypto.randomUUID()}`;
    for(const [value,label]of [["partial","部分消去"],["stroke","ストローク消去"]] as const){
      const wrap=this.doc.createElement("label"),radio=this.doc.createElement("input");radio.type="radio";radio.name=group;radio.value=value;
      radio.addEventListener("change",()=>{if(radio.checked){this.controller.flushPendingStrokes();this.controller.setToolState({eraserMode:value});this.refresh();}});
      wrap.append(radio,label);this.eraserModes.append(wrap);
    }
    this.tools.append(this.eraserModes);
    this.lasso=new NativePdfLasso(binding,this.controller,()=>this.app.workspace.activeLeaf?.view===this.binding.view);
    button("undo","undo-2","元に戻す",()=>this.controller.undo());button("redo","redo-2","やり直す",()=>this.controller.redo());
    button("save","save","書き込みを保存",()=>{void this.save().catch(()=>{});});
    this.floatingToolbar=new FloatingInkToolbar(content,this.tools,dock,this.eraserModes,this.buttons.get("eraser")!);
    for(const [icon,label,action]of [["file-down","書き込み入りPDFを書き出す",()=>{void this.exportPdfCopy();}],["x","手書きを終了",()=>{void this.close().catch(()=>{});}]] as const){
      if(typeof binding.view.addAction==="function")this.actions.push(binding.view.addAction(icon,label,action));
    }
    binding.viewer.container.addEventListener("contextmenu",this.onContextMenu,true);
    this.doc.addEventListener("keydown",this.onKeyDown,true);
    this.originalUnload=binding.view.onUnloadFile;this.originalClose=binding.view.onClose;
    const session=this;
    this.unloadHook=async function(this:any,...args:any[]){await session.close();return session.originalUnload?.apply(this,args);};
    this.closeHook=async function(this:any,...args:any[]){await session.close();return session.originalClose?.apply(this,args);};
    binding.view.onUnloadFile=this.unloadHook;binding.view.onClose=this.closeHook;this.refresh();
  }
  get sourcePath():string{return this.controller.annotation.sourcePath;}
  get closed():boolean{return this.disposed;}
  async save():Promise<void>{this.controller.flushPendingStrokes();this.queue.markDirty();await this.queue.flush();new Notice("書き込みを保存しました。");}
  async close():Promise<void>{
    if(this.disposed)return;if(this.closing)return this.closing;
    this.closing=(async()=>{this.controller.flushPendingStrokes();await this.queue.flush();this.destroy();})();
    try{await this.closing;}finally{this.closing=null;}
  }
  /** Plugin unload cannot await Obsidian's hook; start the final save before removing listeners. */
  unload():void{void this.close().catch(error=>{console.error("Note Ink: final PDF save failed",error);this.destroy();new Notice("書き込みの最終保存に失敗しました。プラグインを閉じる前に保存を確認してください。",10000);});}
  private destroy():void{
    if(this.disposed)return;this.disposed=true;this.floatingToolbar.destroy();this.lasso.destroy();this.controller.destroy();this.queue.setPaused(true);
    this.tools.remove();for(const action of this.actions)action.remove();this.errorEl?.remove();
    this.binding.viewer.container.removeEventListener("contextmenu",this.onContextMenu,true);this.doc.removeEventListener("keydown",this.onKeyDown,true);
    if(this.binding.view.onUnloadFile===this.unloadHook)this.binding.view.onUnloadFile=this.originalUnload;
    if(this.binding.view.onClose===this.closeHook)this.binding.view.onClose=this.originalClose;
    this.binding.view.contentEl.classList.remove("note-ink-native-host");
    this.onClosed();
  }
  private setTool(tool:InkTool):void{
    this.controller.flushPendingStrokes();
    if(tool==="eraser"&&!this.lassoMode&&this.controller.getToolState().tool==="eraser")tool=this.drawingTool;
    if(tool!=="eraser")this.drawingTool=tool;
    this.lassoMode=false;this.lasso.setEnabled(false);this.controller.setInputEnabled(true);this.controller.setToolState({tool});this.refresh();
  }
  private refresh():void{
    if(this.disposed||!this.buttons.size)return;const state=this.controller.getToolState();
    for(const tool of ["pen","highlighter","eraser"]){const b=this.buttons.get(tool)!;b.classList.toggle("mobile-ink-active",!this.lassoMode&&state.tool===tool);b.setAttribute("aria-pressed",String(!this.lassoMode&&state.tool===tool));}
    this.buttons.get("lasso")!.setAttribute("aria-pressed",String(this.lassoMode));this.buttons.get("lasso")!.classList.toggle("mobile-ink-active",this.lassoMode);
    this.buttons.get("undo")!.disabled=!this.controller.canUndo();this.buttons.get("redo")!.disabled=!this.controller.canRedo();
    this.color.value=state.tool==="highlighter"?state.highlighterColor:state.color;this.color.disabled=this.lassoMode||state.tool==="eraser";
    this.floatingToolbar?.setPanelVisible(!this.lassoMode&&state.tool==="eraser");
    for(const radio of this.eraserModes.querySelectorAll<HTMLInputElement>("input"))radio.checked=radio.value===state.eraserMode;
    this.width.disabled=this.lassoMode;
    this.width.setAttribute("aria-label",state.tool==="eraser"?"消しゴムの大きさ":"太さ");
    this.width.max=state.tool==="pen"?"12":state.tool==="highlighter"?"40":"72";
    this.width.value=String(state.tool==="eraser"?state.eraserRadius:state.tool==="highlighter"?state.highlighterWidth:state.width);
    this.widthValue.value=this.width.value;
  }
  private showError(error:unknown):void{
    console.error("Note Ink: PDF annotation save failed",error);if(this.disposed)return;
    if(!this.errorEl){this.errorEl=this.doc.createElement("div");this.errorEl.className="note-ink-save-error";this.errorEl.setAttribute("role","alert");this.binding.view.contentEl.append(this.errorEl);}
    this.errorEl.replaceChildren();const message=this.doc.createElement("span");message.textContent=error instanceof Error?error.message:"書き込みを保存できませんでした。";
    const retry=this.doc.createElement("button");retry.type="button";retry.textContent="再試行";retry.onclick=()=>{retry.disabled=true;void this.queue.flush().catch(()=>{}).finally(()=>{retry.disabled=false;});};this.errorEl.append(message,retry);
  }
  async exportPdfCopy():Promise<void>{
    if(this.exporting||this.disposed)return;this.exporting=true;
    const notice=new Notice("書き込み入りPDFを作成しています…",0);
    try{
      this.controller.flushPendingStrokes();
      // Export is also a recovery route if annotation storage is full or has a sync conflict.
      try{await this.queue.flush();}catch{new Notice("書き込みデータを保存できませんでしたが、現在の書き込みをPDFに書き出します。",8000);}
      if(this.binding.viewer.pdfDocument!==this.binding.pdf)throw new Error("表示するPDFが更新されました。手書きを再開してください。");
      const bytes=await exportNativePdf(this.binding.pdf,this.controller.annotation,(done,total)=>notice.setMessage(`PDFを作成しています… ${done}/${total}ページ`));
      const path=await saveExportCopy(this.app.vault,this.sourcePath,bytes);notice.setMessage(`保存しました：${path}`);setTimeout(()=>notice.hide(),8000);
    }catch(error){notice.hide();new Notice(`PDFを保存できませんでした。${error instanceof Error?error.message:"保存先を確認してください。"}`,10000);}
    finally{this.exporting=false;}
  }
  private onKeyDown=(event:KeyboardEvent):void=>{
    if(this.disposed||this.app.workspace.activeLeaf?.view!==this.binding.view)return;
    if(event.target instanceof Element&&event.target.closest("input,textarea,[contenteditable=true]"))return;
    if(!(event.ctrlKey||event.metaKey))return;
    if(event.key.toLowerCase()==="z"){event.preventDefault();event.stopPropagation();event.shiftKey?this.controller.redo():this.controller.undo();}
    if(event.key.toLowerCase()==="s"){event.preventDefault();event.stopPropagation();void this.save().catch(()=>{});}
  };
  private onContextMenu=(event:MouseEvent):void=>{
    const target=(event.target as Element)?.closest?.(".page[data-page-number]"),n=Number((target as HTMLElement)?.dataset.pageNumber);
    const page=n?this.binding.viewer.getPageView(n-1):null,box=page?.canvas?.getBoundingClientRect();
    let hit:PdfTextAnnotation|undefined;
    if(page&&box){const [x,y]=transformPoint(invertMatrix(page.viewport.transform),(event.clientX-box.left)*page.viewport.width/box.width,(event.clientY-box.top)*page.viewport.height/box.height);hit=this.controller.annotation.pdfTextAnnotations.find(a=>a.kind!=="note"&&a.pageNumber===n&&a.rects.some(r=>x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height));}
    if(!hit)return;event.preventDefault();event.stopPropagation();const menu=new Menu();
    if(hit){const mark=hit;
      menu.addItem(item=>item.setTitle("この書き込みを削除").setIcon("trash-2").onClick(()=>{this.controller.annotation.pdfTextAnnotations=this.controller.annotation.pdfTextAnnotations.filter(a=>a.id!==mark.id);this.controller.annotationsChanged([mark.pageNumber]);this.queue.markDirty();}));}
    menu.showAtMouseEvent(event);
  };
}
