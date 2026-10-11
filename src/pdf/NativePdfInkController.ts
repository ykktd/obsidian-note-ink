import { InkEngine } from "../ink/InkEngine";
import { StrokeHistory, strokeChange, applyStrokeChange, sameStroke, type StrokeChange } from "../ink/StrokeHistory";
import { drawStrokes, setupCanvas } from "../ink/renderer";
import type { InkStroke, InkToolState, PdfAnnotationFile, PdfInkStroke } from "../ink/types";
import { toPdfStroke, toViewportStroke, pdfMarkShapes, type PdfViewport } from "./pdfCoordinates";
import type { NativePageView, NativePdfBinding } from "./NativePdfViewer";

type Layer={page:NativePageView;el:HTMLDivElement;canvas:HTMLCanvasElement;marks:SVGSVGElement;revision:number;rotation:number};
type Input={page:NativePageView;viewport:PdfViewport;engine:InkEngine;committed:HTMLCanvasElement;live:HTMLCanvasElement;width:number;height:number;reference:readonly InkStroke[]};
type Options={onChange():void;onInputStart():void;onInputEnd():void;onDocumentChanged():void};
const defaults:InkToolState={tool:"pen",color:"#111111",width:2,highlighterColor:"#ffd54a",highlighterWidth:14,eraserRadius:18,eraserMode:"partial",acceptTouchInput:false};
const events=["pagerendered","pagechanging","pagesinit","scalechanging","rotationchanging"];

/** One input engine; only annotated pages near the native viewport own display canvases. */
export class NativePdfInkController {
  private state:InkToolState={...defaults};
  private enabled=true;
  private history=new StrokeHistory();
  private layers=new Map<number,Layer>();
  private revisions=new Map<number,number>();
  private input:Input|null=null;
  private raf:number|null=null;
  private observer:MutationObserver;
  private disposed=false;
  private applying=false;
  private penPage:HTMLElement|null=null;
  private cursor:HTMLDivElement|null=null;
  private readonly doc:Document;
  private readonly win:Window;
  // Useful for regression checks without timing noise from the PDF renderer.
  readonly diagnostics={displayRenders:0,inputMounts:0,inputReleases:0};

  constructor(readonly binding:NativePdfBinding,readonly annotation:PdfAnnotationFile,private options:Options){
    this.doc=binding.viewer.container.ownerDocument;this.win=this.doc.defaultView!;
    for(const name of events)binding.eventBus.on(name,this.onViewerEvent);
    this.observer=new MutationObserver(()=>this.queueSync());
    this.observer.observe(binding.viewer.viewer,{subtree:true,childList:true});
    binding.viewer.container.addEventListener("scroll",this.onScroll,{passive:true});
    this.win.addEventListener("pointerdown",this.preparePointer,true);
    this.win.addEventListener("pointermove",this.showCursor,true);
    this.win.addEventListener("pointerup",this.hideCursor,true);
    this.win.addEventListener("pointercancel",this.hideCursor,true);
    this.win.addEventListener("blur",this.hideCursor);
    this.binding.viewer.container.addEventListener("pointerleave",this.hideCursor);
    this.win.addEventListener("touchstart",this.prepareTouch,{capture:true,passive:true});
    this.win.addEventListener("touchmove",this.touchCursor,{capture:true,passive:true});
    this.win.addEventListener("touchend",this.hideCursor,true);
    this.win.addEventListener("touchcancel",this.hideCursor,true);
    this.queueSync();
  }
  getStrokes():PdfInkStroke[]{return structuredClone(this.annotation.strokes);}
  getToolState():InkToolState{return {...this.state};}
  setToolState(patch:Partial<InkToolState>):void{this.hideCursor();this.state={...this.state,...patch};this.input?.engine.setToolState(patch);}
  setInputEnabled(enabled:boolean):void{this.enabled=enabled;if(!enabled){this.hideCursor();this.releaseInput();this.restorePenPage();}}
  isInputActive():boolean{return this.input?.engine.isInputActive()??false;}
  flushPendingStrokes():void{this.input?.engine.flushPendingStrokes();}
  canUndo():boolean{return this.history.canUndo;}
  canRedo():boolean{return this.history.canRedo;}
  undo():void{this.flushPendingStrokes();const change=this.history.undo();if(!change)return;this.applyHistory(change,false);}
  redo():void{this.flushPendingStrokes();const change=this.history.redo();if(!change)return;this.applyHistory(change,true);}
  private applyHistory(change:StrokeChange,forward:boolean):void{
    this.annotation.strokes=applyStrokeChange(this.annotation.strokes,change,forward) as PdfInkStroke[];
    for(const {stroke}of [...change.added,...change.removed])this.invalidate((stroke as PdfInkStroke).pageNumber);
    this.refreshInput();this.options.onChange();this.queueSync();
  }
  replaceStrokes(strokes:PdfInkStroke[]):void{
    this.flushPendingStrokes();const change=strokeChange(this.annotation.strokes,strokes);this.history.record(change);
    this.annotation.strokes=structuredClone(strokes);
    for(const {stroke}of [...change.added,...change.removed])this.invalidate((stroke as PdfInkStroke).pageNumber);
    this.refreshInput();this.options.onChange();this.queueSync();
  }
  annotationsChanged(pageNumbers:number[]):void{for(const n of pageNumbers)this.invalidate(n);this.queueSync();}
  destroy():void{
    if(this.disposed)return;this.releaseInput();this.disposed=true;this.restorePenPage();
    if(this.raf!==null)this.win.cancelAnimationFrame(this.raf);this.raf=null;
    this.observer.disconnect();for(const name of events)this.binding.eventBus.off(name,this.onViewerEvent);
    this.binding.viewer.container.removeEventListener("scroll",this.onScroll);
    this.win.removeEventListener("pointerdown",this.preparePointer,true);
    this.win.removeEventListener("pointermove",this.showCursor,true);
    this.win.removeEventListener("pointerup",this.hideCursor,true);
    this.win.removeEventListener("pointercancel",this.hideCursor,true);
    this.win.removeEventListener("blur",this.hideCursor);
    this.binding.viewer.container.removeEventListener("pointerleave",this.hideCursor);this.hideCursor();
    this.win.removeEventListener("touchstart",this.prepareTouch,true);
    this.win.removeEventListener("touchmove",this.touchCursor,true);
    this.win.removeEventListener("touchend",this.hideCursor,true);
    this.win.removeEventListener("touchcancel",this.hideCursor,true);
    for(const layer of this.layers.values())this.removeLayer(layer);this.layers.clear();
  }
  private invalidate(n:number):void{this.revisions.set(n,(this.revisions.get(n)??0)+1);}
  private onViewerEvent=(data?:any):void=>{
    this.hideCursor();
    if(this.binding.viewer.pdfDocument!==this.binding.pdf){this.enabled=false;this.releaseInput();this.options.onDocumentChanged();return;}
    // The captured viewport belongs to the engine, even if native pages were already reset.
    if(data?.scale!==undefined||data?.pagesRotation!==undefined||this.input&&!this.input.live.isConnected)this.releaseInput();
    this.queueSync();
  };
  private onScroll=():void=>{this.hideCursor();if(!this.isInputActive())this.releaseInput();this.queueSync();};
  private queueSync():void{
    if(this.disposed||this.raf!==null)return;
    this.raf=this.win.requestAnimationFrame(()=>{this.raf=null;this.sync();});
  }
  private sync():void{
    if(this.disposed||this.binding.viewer.pdfDocument!==this.binding.pdf)return;
    if(this.input&&(!this.input.live.isConnected||this.input.viewport.rotation!==this.input.page.viewport.rotation))this.releaseInput();
    const box=this.binding.viewer.container.getBoundingClientRect(),wanted=new Set<number>();
    for(const div of this.binding.viewer.viewer.querySelectorAll<HTMLElement>(".page[data-page-number]")){
      const page=this.binding.viewer.getPageView(Number(div.dataset.pageNumber)-1);
      if(!page||page.div!==div)continue;
      if(!page.pdfPage)continue;const rect=page.div.getBoundingClientRect();
      if(rect.bottom<box.top-100||rect.top>box.bottom+100)continue;
      if(!this.annotation.strokes.some(s=>s.pageNumber===page.id)&&!this.annotation.pdfTextAnnotations.some(a=>a.kind!=="note"&&a.pageNumber===page.id))continue;
      wanted.add(page.id);this.updateLayer(page);
    }
    for(const [n,layer]of this.layers)if(!wanted.has(n)&&this.input?.page.id!==n){this.removeLayer(layer);this.layers.delete(n);}
  }
  private updateLayer(page:NativePageView):void{
    let layer=this.layers.get(page.id);
    if(layer && layer.page!==page){this.removeLayer(layer);this.layers.delete(page.id);layer=undefined;}
    if(!layer){
      const el=this.doc.createElement("div"),canvas=this.doc.createElement("canvas");
      el.className="note-ink-native-overlay";el.setAttribute("aria-hidden","true");
      el.dataset.pageNumber=String(page.id);
      const marks=this.doc.createElementNS("http://www.w3.org/2000/svg","svg");marks.setAttribute("preserveAspectRatio","none");el.append(marks,canvas);
      layer={page,el,canvas,marks,revision:-1,rotation:NaN};this.layers.set(page.id,layer);
    }
    if(layer.el.parentElement!==page.div)page.div.append(layer.el);
    const viewport=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});
    const revision=this.revisions.get(page.id)??0;
    // Keep all painting in a page-local HTML canvas. A canvas in SVG foreignObject
    // is composited at the wrong origin/scale in WebKit, unlike the live HTML canvas.
    if(layer.revision!==revision || layer.rotation!==viewport.rotation){
      const dpr=Math.max(.25,Math.min(3,page.viewport.scale*(this.win.devicePixelRatio||1)));
      const ctx=setupCanvas(layer.canvas,viewport.width,viewport.height,{maxDpr:dpr,maxPixels:1_000_000});
      layer.canvas.style.width=layer.canvas.style.height="100%";
      layer.marks.setAttribute("viewBox",`0 0 ${viewport.width} ${viewport.height}`);layer.marks.replaceChildren();
      for(const mark of this.annotation.pdfTextAnnotations.filter(a=>a.kind!=="note"&&a.pageNumber===page.id))for(const r of pdfMarkShapes(mark,page.pdfPage!,viewport)){
        const rect=this.doc.createElementNS(layer.marks.namespaceURI,"rect");
        for(const [key,value]of Object.entries(r))rect.setAttribute(key,String(value));
        rect.setAttribute("fill",mark.color);rect.setAttribute("opacity",mark.kind==="underline"||mark.kind==="strikethrough"?".86":".42");layer.marks.append(rect);
      }
      drawStrokes(ctx,this.annotation.strokes.filter(s=>s.pageNumber===page.id).map(s=>toViewportStroke(s,viewport)));
      layer.revision=revision;layer.rotation=viewport.rotation;this.diagnostics.displayRenders++;
    }
    layer.canvas.style.visibility=this.input?.page.id===page.id?"hidden":"visible";
  }
  private removeLayer(layer:Layer):void{layer.el.remove();layer.canvas.width=layer.canvas.height=0;}
  private pageForTarget(target:EventTarget|null):NativePageView|null{
    if(!target||typeof (target as Node).nodeType!=="number"||!this.binding.viewer.viewer.contains(target as Node))return null;
    const element=(target as Node).nodeType===1?target as Element:(target as Node).parentElement;
    const div=element?.closest<HTMLElement>(".page[data-page-number]");if(!div)return null;
    const n=Number(div.dataset.pageNumber),page=this.binding.viewer.getPageView(n-1);
    return page?.pdfPage&&page.div===div?page:null;
  }
  private hideCursor=():void=>{this.cursor?.remove();this.cursor=null;};
  private showCursor=(event:Pick<PointerEvent,"pointerType"|"target"|"clientX"|"clientY">):void=>{
    if(!this.enabled||this.state.tool!=="eraser"||!["pen","mouse"].includes(event.pointerType)){this.hideCursor();return;}
    const page=this.pageForTarget(event.target);if(!page){this.hideCursor();return;}
    const r=page.div.getBoundingClientRect(),v=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});
    if(!this.cursor){this.cursor=this.doc.createElement("div");this.cursor.className="note-ink-eraser-cursor";this.cursor.setAttribute("aria-hidden","true");}
    if(this.cursor.parentElement!==page.div)page.div.append(this.cursor);
    this.cursor.style.left=`${(event.clientX-r.left)/r.width*100}%`;this.cursor.style.top=`${(event.clientY-r.top)/r.height*100}%`;
    this.cursor.style.width=`${this.state.eraserRadius*2/v.width*100}%`;this.cursor.style.height=`${this.state.eraserRadius*2/v.height*100}%`;
  };
  private preparePenPage=(event:PointerEvent):void=>{
    if(!this.enabled||event.pointerType!=="pen")return;
    const page=this.pageForTarget(event.target);if(!page)return;
    if(this.penPage!==page.div){this.restorePenPage();this.penPage=page.div;this.penPage.classList.add("note-ink-pen-contact");}
  };
  private restorePenPage():void{this.penPage?.classList.remove("note-ink-pen-contact");this.penPage=null;}
  private preparePointer=(event:PointerEvent):void=>{
    if(!this.enabled||!["pen","mouse"].includes(event.pointerType)||event.button!==0)return;
    const page=this.pageForTarget(event.target);if(!page)return;
    this.mountInput(page);this.preparePenPage(event);this.showCursor(event);
  };
  private touchCursor=(event:TouchEvent):void=>{
    const touch=event.changedTouches.item(0) as Touch&{touchType?:string}|null;
    if(touch?.touchType==="stylus"&&event.touches.length===1)this.showCursor({pointerType:"pen",target:touch.target,clientX:touch.clientX,clientY:touch.clientY});else this.hideCursor();
  };
  private prepareTouch=(event:TouchEvent):void=>{
    if(!this.enabled)return;
    if(event.touches.length>1){this.releaseInput();this.restorePenPage();return;}
    const touch=event.changedTouches.item(0) as Touch&{touchType?:string}|null;
    if(touch?.touchType!=="stylus")return;
    const page=this.pageForTarget(touch.target);if(page){this.mountInput(page);this.touchCursor(event);}
  };
  private mountInput(page:NativePageView):void{
    if(this.input?.page===page&&this.input.live.isConnected&&this.input.viewport.rotation===page.viewport.rotation)return;
    this.releaseInput();const viewport=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});
    const committed=this.doc.createElement("canvas"),live=this.doc.createElement("canvas");
    committed.className="note-ink-native-committed";live.className="note-ink-native-live";
    committed.setAttribute("aria-hidden","true");live.setAttribute("aria-hidden","true");page.div.append(committed,live);
    const engine=new InkEngine(live,committed,this.binding.viewer.container,{nativeScroll:true,inputRoot:page.div,externalHistory:true,panOutsideCanvas:false,recoverPointerOnMove:false,
      canvasMaxDpr:Math.min(3,Math.max(1,page.viewport.scale*(this.win.devicePixelRatio||1))),canvasMaxPixels:2_000_000,initialToolState:this.state,
      onChange:()=>this.commitInput(),onInputStart:()=>this.options.onInputStart(),onInputEnd:()=>{this.restorePenPage();this.options.onInputEnd();this.queueSync();}});
    const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);engine.resize(width,height);
    this.input={page,viewport,engine,committed,live,width,height,reference:[]};this.diagnostics.inputMounts++;
    committed.style.width=live.style.width="100%";committed.style.height=live.style.height="100%";
    engine.loadStrokes(this.localStrokes(this.input));this.input.reference=[...engine.getStrokeRefs()];this.layers.get(page.id)?.canvas.style.setProperty("visibility","hidden");
  }
  private localStrokes(input:Input):InkStroke[]{
    return this.annotation.strokes.filter(s=>s.pageNumber===input.page.id).map(s=>{
      const local=toViewportStroke(s,input.viewport);
      return {...local,erasures:local.erasures?.map(e=>({...e,points:e.points.map(p=>({x:p.x*input.width/input.viewport.width,y:p.y*input.height/input.viewport.height}))})),points:local.points.map(p=>({...p,x:p.x*input.width/input.viewport.width,y:p.y*input.height/input.viewport.height}))};
    });
  }
  private commitInput():void{
    const input=this.input;if(!input||this.applying)return;
    const before=this.annotation.strokes.filter(s=>s.pageNumber===input.page.id);
    const reference=new Map(input.reference.map(s=>[s.id,s])),original=new Map(before.map(s=>[s.id,s]));
    const after=input.engine.getStrokeRefs().map(s=>reference.has(s.id)&&sameStroke(reference.get(s.id)!,s)&&original.has(s.id)?original.get(s.id)!:toPdfStroke(s,input.page.id,input.viewport,input.width,input.height));
    input.reference=[...input.engine.getStrokeRefs()];
    const change=strokeChange(before,after);if(!change.added.length&&!change.removed.length)return;
    const updated=new Map(after.map(s=>[s.id,s]));
    const next=this.annotation.strokes.flatMap(s=>s.pageNumber!==input.page.id?[s]:updated.has(s.id)?[updated.get(s.id)!]:[]);
    for(const stroke of after)if(!original.has(stroke.id))next.push(stroke);
    this.history.record(strokeChange(this.annotation.strokes,next));this.annotation.strokes=next;
    this.invalidate(input.page.id);this.options.onChange();this.queueSync();
  }
  private refreshInput():void{
    if(!this.input)return;this.applying=true;
    try{this.input.engine.replaceStrokes(this.localStrokes(this.input),false);this.input.reference=[...this.input.engine.getStrokeRefs()];}finally{this.applying=false;}
  }
  private releaseInput():void{
    const input=this.input;if(!input)return;
    input.engine.flushPendingStrokes();this.commitInput();this.input=null;input.engine.destroy();
    input.committed.remove();input.live.remove();input.committed.width=input.committed.height=input.live.width=input.live.height=0;
    this.layers.get(input.page.id)?.canvas.style.setProperty("visibility","visible");this.diagnostics.inputReleases++;this.restorePenPage();
  }
}
