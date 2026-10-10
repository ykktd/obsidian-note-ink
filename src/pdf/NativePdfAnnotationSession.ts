import { Menu, Modal, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { SaveQueue } from "../ink/SaveQueue";
import type { StrokeStore } from "../ink/StrokeStore";
import type { InkTool, PdfTextAnnotation, PdfTextAnnotationRect } from "../ink/types";
import { QuickEraserControl } from "../ui/QuickEraserControl";
import { NativePdfInkController } from "./NativePdfInkController";
import { connectNativePdf, type NativePdfBinding } from "./NativePdfViewer";
import { invertMatrix, transformPoint } from "./exportAnnotatedPdf";
import { transformRect } from "./pdfCoordinates";
import { exportNativePdf } from "./exportNativePdf";
import { saveExportCopy } from "./saveExportCopy";

export class NativePdfAnnotationSession {
  readonly controller:NativePdfInkController;
  private raw:string|null;
  private queue:SaveQueue;
  private tools:HTMLElement;
  private buttons=new Map<string,HTMLButtonElement>();
  private readMode=false;
  private drawingTool:InkTool="pen";
  private width:HTMLInputElement;
  private color:HTMLInputElement;
  private quick:QuickEraserControl;
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

  static async open(app:App,store:StrokeStore,leaf:WorkspaceLeaf,path:string):Promise<NativePdfAnnotationSession>{
    const binding=await connectNativePdf(leaf,path),loaded=await store.loadPdf(path,binding.pdf);
    if(leaf.view!==binding.view||binding.view.file?.path!==path||binding.viewer.pdfDocument!==binding.pdf)throw new Error("表示するPDFが変わりました。もう一度、注釈を開いてください。");
    return new NativePdfAnnotationSession(app,store,leaf,binding,loaded);
  }
  private constructor(private app:App,private store:StrokeStore,readonly leaf:WorkspaceLeaf,readonly binding:NativePdfBinding,loaded:Awaited<ReturnType<StrokeStore["loadPdf"]>>){
    this.raw=loaded.raw;this.doc=binding.viewer.container.ownerDocument;
    this.queue=new SaveQueue(async()=>{this.controller.flushPendingStrokes();this.raw=await store.savePdf(this.controller.annotation,this.raw);},800,
      error=>this.showError(error),()=>{this.errorEl?.remove();this.errorEl=null;});
    this.controller=new NativePdfInkController(binding,loaded.annotation,{onChange:()=>{this.queue.markDirty();this.refresh();},
      onInputStart:()=>this.queue.setPaused(true),onInputEnd:()=>{this.queue.setPaused(false);this.quick?.inputEnded();this.refresh();},
      onDocumentChanged:()=>{void this.close().then(()=>new Notice("PDFが更新されたため、注釈を閉じました。注釈を開き直してください。")).catch(error=>this.showError(error));}});
    const content=binding.view.contentEl as HTMLElement;content.classList.add("note-ink-native-host");
    this.tools=this.doc.createElement("div");this.tools.className="mobile-ink-toolbar note-ink-native-tools";this.tools.setAttribute("aria-label","注釈ツールバー");
    const dock=this.doc.createElement("div");dock.className="mobile-ink-toolbar-dock";this.tools.append(dock);content.append(this.tools);
    const button=(key:string,icon:string,label:string,action:()=>void)=>{
      const b=this.doc.createElement("button");b.type="button";b.className="mobile-ink-icon-button";b.setAttribute("aria-label",label);b.title=label;setIcon(b,icon);b.addEventListener("click",action);dock.append(b);this.buttons.set(key,b);return b;
    };
    button("pen","pencil","ペン",()=>this.setTool("pen"));button("highlighter","highlighter","蛍光ペン",()=>this.setTool("highlighter"));button("eraser","eraser","消しゴム",()=>this.setTool("eraser"));
    button("read","text-select","閲覧・文字選択",()=>{this.quick?.cancel();this.readMode=true;this.controller.setInputEnabled(false);this.refresh();});
    this.color=this.doc.createElement("input");this.color.type="color";this.color.setAttribute("aria-label","色");this.color.title="色";this.color.addEventListener("input",()=>{const state=this.controller.getToolState();this.controller.setToolState(state.tool==="highlighter"?{highlighterColor:this.color.value}:{color:this.color.value});});dock.append(this.color);
    const widthLabel=this.doc.createElement("label");widthLabel.className="note-ink-native-width";widthLabel.append("太さ");this.width=this.doc.createElement("input");this.width.type="number";this.width.min=".5";this.width.max="72";this.width.step=".5";this.width.setAttribute("aria-label","太さ");widthLabel.append(this.width);dock.append(widthLabel);
    this.width.addEventListener("change",()=>{const value=Number(this.width.value),state=this.controller.getToolState();if(!Number.isFinite(value)||value<.5||value>72){this.refresh();return;}this.controller.setToolState(state.tool==="eraser"?{eraserRadius:value}:state.tool==="highlighter"?{highlighterWidth:value}:{width:value});});
    button("undo","undo-2","元に戻す",()=>this.controller.undo());button("redo","redo-2","やり直す",()=>this.controller.redo());
    button("save","save","注釈を保存",()=>{void this.save().catch(()=>{});});
    const quick=this.doc.createElement("button");quick.type="button";quick.className="mobile-ink-quick-eraser note-ink-native-quick";const icon=this.doc.createElement("span"),label=this.doc.createElement("span");label.className="mobile-ink-quick-eraser-label";setIcon(icon,"eraser");quick.append(icon,label);content.append(quick);
    this.quick=new QuickEraserControl(quick,label,()=>{if(this.readMode||this.disposed)return null;this.controller.flushPendingStrokes();const tool=this.controller.getToolState().tool;this.controller.setToolState({tool:"eraser"});this.refresh();return()=>{this.controller.flushPendingStrokes();this.controller.setToolState({tool});this.refresh();};});
    this.actions.push(quick);
    for(const [icon,label,action]of [["file-down","書き込み入りPDFを書き出す",()=>{void this.exportPdfCopy();}],["x","注釈を閉じる",()=>{void this.close().catch(()=>{});}]] as const){
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
  async save():Promise<void>{this.controller.flushPendingStrokes();this.queue.markDirty();await this.queue.flush();new Notice("注釈を保存しました。");}
  async close():Promise<void>{
    if(this.disposed)return;if(this.closing)return this.closing;
    this.closing=(async()=>{this.quick.cancel();this.controller.flushPendingStrokes();await this.queue.flush();this.destroy();})();
    try{await this.closing;}finally{this.closing=null;}
  }
  /** Plugin unload cannot await Obsidian's hook; start the final save before removing listeners. */
  unload():void{void this.close().catch(error=>{console.error("Note Ink: final PDF save failed",error);this.destroy();new Notice("注釈の最終保存に失敗しました。プラグインを閉じる前に保存を確認してください。",10000);});}
  private destroy():void{
    if(this.disposed)return;this.disposed=true;this.quick.destroy();this.controller.destroy();this.queue.setPaused(true);
    this.tools.remove();for(const action of this.actions)action.remove();this.errorEl?.remove();
    this.binding.viewer.container.removeEventListener("contextmenu",this.onContextMenu,true);this.doc.removeEventListener("keydown",this.onKeyDown,true);
    if(this.binding.view.onUnloadFile===this.unloadHook)this.binding.view.onUnloadFile=this.originalUnload;
    if(this.binding.view.onClose===this.closeHook)this.binding.view.onClose=this.originalClose;
    this.binding.view.contentEl.classList.remove("note-ink-native-host");
  }
  private setTool(tool:InkTool):void{
    this.quick.cancel();
    if(tool==="eraser"&&!this.readMode&&this.controller.getToolState().tool==="eraser")tool=this.drawingTool;
    if(tool!=="eraser")this.drawingTool=tool;
    this.readMode=false;this.controller.setInputEnabled(true);this.controller.setToolState({tool});this.refresh();
  }
  private refresh():void{
    if(this.disposed||!this.buttons.size)return;const state=this.controller.getToolState();
    for(const tool of ["pen","highlighter","eraser"]){const b=this.buttons.get(tool)!;b.classList.toggle("mobile-ink-active",!this.readMode&&state.tool===tool);b.setAttribute("aria-pressed",String(!this.readMode&&state.tool===tool));}
    this.buttons.get("read")!.setAttribute("aria-pressed",String(this.readMode));this.buttons.get("read")!.classList.toggle("mobile-ink-active",this.readMode);
    this.buttons.get("undo")!.disabled=!this.controller.canUndo();this.buttons.get("redo")!.disabled=!this.controller.canRedo();
    this.color.value=state.tool==="highlighter"?state.highlighterColor:state.color;this.color.disabled=state.tool==="eraser";
    this.width.value=String(state.tool==="eraser"?state.eraserRadius:state.tool==="highlighter"?state.highlighterWidth:state.width);
  }
  private showError(error:unknown):void{
    console.error("Note Ink: PDF annotation save failed",error);if(this.disposed)return;
    if(!this.errorEl){this.errorEl=this.doc.createElement("div");this.errorEl.className="note-ink-save-error";this.errorEl.setAttribute("role","alert");this.binding.view.contentEl.append(this.errorEl);}
    this.errorEl.replaceChildren();const message=this.doc.createElement("span");message.textContent=error instanceof Error?error.message:"注釈を保存できませんでした。";
    const retry=this.doc.createElement("button");retry.type="button";retry.textContent="再試行";retry.onclick=()=>{retry.disabled=true;void this.queue.flush().catch(()=>{}).finally(()=>{retry.disabled=false;});};this.errorEl.append(message,retry);
  }
  async exportPdfCopy():Promise<void>{
    if(this.exporting||this.disposed)return;this.exporting=true;
    const notice=new Notice("書き込み入りPDFを作成しています…",0);
    try{
      this.controller.flushPendingStrokes();
      // Export is also a recovery route if annotation storage is full or has a sync conflict.
      try{await this.queue.flush();}catch{new Notice("注釈データを保存できませんでしたが、現在の書き込みをPDFに書き出します。",8000);}
      if(this.binding.viewer.pdfDocument!==this.binding.pdf)throw new Error("表示するPDFが更新されました。注釈を開き直してください。");
      const bytes=await exportNativePdf(this.binding.pdf,this.controller.annotation,(done,total)=>notice.setMessage(`PDFを作成しています… ${done}/${total}ページ`));
      const path=await saveExportCopy(this.app.vault,this.sourcePath,bytes);notice.setMessage(`保存しました：${path}`);setTimeout(()=>notice.hide(),8000);
    }catch(error){notice.hide();new Notice(`PDFを保存できませんでした。${error instanceof Error?error.message:"保存先を確認してください。"}`,10000);}
    finally{this.exporting=false;}
  }
  private onKeyDown=(event:KeyboardEvent):void=>{
    if(this.disposed||this.app.workspace.activeLeaf?.view!==this.binding.view)return;
    if(event.target instanceof Element&&event.target.closest("input,textarea,[contenteditable=true]"))return;
    if(event.key==="Escape"&&this.quick.active){event.preventDefault();this.quick.cancel();return;}
    if(!(event.ctrlKey||event.metaKey))return;
    if(event.key.toLowerCase()==="z"){event.preventDefault();event.stopPropagation();event.shiftKey?this.controller.redo():this.controller.undo();}
    if(event.key.toLowerCase()==="s"){event.preventDefault();event.stopPropagation();void this.save().catch(()=>{});}
  };
  private selection():Omit<PdfTextAnnotation,"id"|"kind"|"color"|"createdAt">[]{
    const selection=this.doc.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return [];
    const range=selection.getRangeAt(0);if(!this.binding.viewer.viewer.contains(range.commonAncestorContainer))return [];
    const result:Omit<PdfTextAnnotation,"id"|"kind"|"color"|"createdAt">[]=[];
    for(const page of this.binding.viewer.getCachedPageViews()){
      if(!page.pdfPage||!page.canvas)continue;const box=page.canvas.getBoundingClientRect(),rects:PdfTextAnnotationRect[]=[];
      for(const r of range.getClientRects()){
        const x=Math.max(r.left,box.left),y=Math.max(r.top,box.top),right=Math.min(r.right,box.right),bottom=Math.min(r.bottom,box.bottom);
        if(right<=x||bottom<=y)continue;
        rects.push(transformRect({x:(x-box.left)*page.viewport.width/box.width,y:(y-box.top)*page.viewport.height/box.height,width:(right-x)*page.viewport.width/box.width,height:(bottom-y)*page.viewport.height/box.height},invertMatrix(page.viewport.transform)));
      }
      if(rects.length)result.push({pageNumber:page.id,rotation:page.viewport.rotation,text:selection.toString(),rects});
    }
    return result;
  }
  private onContextMenu=(event:MouseEvent):void=>{
    const selected=this.selection(),target=(event.target as Element)?.closest?.(".page[data-page-number]"),n=Number((target as HTMLElement)?.dataset.pageNumber);
    const page=n?this.binding.viewer.getPageView(n-1):null,box=page?.canvas?.getBoundingClientRect();
    let hit:PdfTextAnnotation|undefined;
    if(page&&box){const [x,y]=transformPoint(invertMatrix(page.viewport.transform),(event.clientX-box.left)*page.viewport.width/box.width,(event.clientY-box.top)*page.viewport.height/box.height);hit=this.controller.annotation.pdfTextAnnotations.find(a=>a.pageNumber===n&&a.rects.some(r=>x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height));}
    if(!selected.length&&!hit)return;event.preventDefault();event.stopPropagation();const menu=new Menu();
    if(selected.length){for(const [kind,label,icon]of [["highlight","ハイライトを付ける","highlighter"],["underline","下線を引く","underline"],["strikethrough","取り消し線を引く","strikethrough"],["note","コメントを付ける","message-square"]] as const)menu.addItem(item=>item.setTitle(label).setIcon(icon).onClick(()=>{
      const create=(note?:string)=>{const color=this.controller.getToolState().highlighterColor;this.controller.annotation.pdfTextAnnotations.push(...selected.map(a=>({...a,id:crypto.randomUUID(),kind,color,note,createdAt:Date.now()})));this.controller.annotationsChanged(selected.map(a=>a.pageNumber));this.queue.markDirty();this.doc.getSelection()?.removeAllRanges();};
      if(kind==="note")new PdfCommentModal(this.app,selected[0].text,create).open();else create();
    }));}
    if(hit){const mark=hit;menu.addSeparator();if(mark.kind==="note")menu.addItem(item=>item.setTitle("コメントを表示・編集").setIcon("message-square").onClick(()=>new PdfCommentModal(this.app,mark.text,note=>{mark.note=note;this.controller.annotationsChanged([mark.pageNumber]);this.queue.markDirty();},mark.note).open()));
      menu.addItem(item=>item.setTitle("この注釈を削除").setIcon("trash-2").onClick(()=>{this.controller.annotation.pdfTextAnnotations=this.controller.annotation.pdfTextAnnotations.filter(a=>a.id!==mark.id);this.controller.annotationsChanged([mark.pageNumber]);this.queue.markDirty();}));}
    menu.showAtMouseEvent(event);
  };
}
class PdfCommentModal extends Modal {
  constructor(app:App,private selected:string,private submit:(value:string)=>void,private initial=""){super(app);}
  onOpen():void{
    this.contentEl.empty();this.contentEl.createEl("h2",{text:"PDFの注釈"});this.contentEl.createDiv({text:this.selected});
    const input=this.contentEl.createEl("textarea",{attr:{"aria-label":"コメント"}});input.value=this.initial;
    const actions=this.contentEl.createDiv({cls:"mobile-ink-pdf-note-actions"}),cancel=actions.createEl("button",{text:"キャンセル"}),save=actions.createEl("button",{text:"保存",cls:"mod-cta"});
    const submit=()=>{if(!input.value.trim()){input.focus();return;}this.submit(input.value.trim());this.close();};cancel.onclick=()=>this.close();save.onclick=submit;input.onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();submit();}};setTimeout(()=>input.focus(),0);
  }
}
