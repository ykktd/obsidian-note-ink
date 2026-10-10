import type { InkStroke } from '../ink/types';
import { lassoHits, strokeBounds, transformStrokes, type Point, type Bounds } from '../ink/lasso';
import { drawStrokes, setupCanvas } from '../ink/renderer';
import { toPdfStroke, toViewportStroke, type PdfViewport } from './pdfCoordinates';
import type { NativePageView, NativePdfBinding } from './NativePdfViewer';
import type { NativePdfInkController } from './NativePdfInkController';

type Gesture={id:number;kind:'lasso'|'move'|'scale'|'rotate';start:Point;points:Point[];source:InkStroke[];bounds:Bounds|null;changed:boolean};
const viewerEvents=['scalechanging','rotationchanging','pagechanging'];
/** Selection is ephemeral. Only a finished gesture enters the existing save/history path. */
export class NativePdfLasso {
  readonly panel:HTMLDivElement;
  private enabled=false;
  private page:NativePageView|null=null;
  private viewport:PdfViewport|null=null;
  private ids=new Set<string>();
  private gesture:Gesture|null=null;
  private overlay:HTMLDivElement|null=null;
  private svg:SVGSVGElement|null=null;
  private preview:HTMLCanvasElement|null=null;
  private clipboard:InkStroke[]=[];
  private status:HTMLDivElement;
  private selectionButtons:HTMLButtonElement[]=[];
  private pasteButton:HTMLButtonElement;
  private readonly doc:Document;
  private readonly win:Window;
  constructor(private binding:NativePdfBinding,private controller:NativePdfInkController,private isActive:()=>boolean){
    this.doc=binding.viewer.container.ownerDocument;this.win=this.doc.defaultView!;
    this.panel=this.doc.createElement('div');this.panel.className='note-ink-lasso-panel';this.panel.hidden=true;
    this.status=this.doc.createElement('div');this.status.setAttribute('role','status');this.panel.append(this.status);
    const hint=this.doc.createElement('div');hint.className='note-ink-lasso-hint';hint.textContent='ペンで囲む → 枠内をドラッグで移動・右下で拡大縮小・上で回転';this.panel.append(hint);
    const grid=this.doc.createElement('div');grid.className='note-ink-lasso-actions';this.panel.append(grid);
    const button=(label:string,action:()=>void,needsSelection=true)=>{const b=this.doc.createElement('button');b.type='button';b.textContent=label;b.onclick=action;grid.append(b);if(needsSelection)this.selectionButtons.push(b);return b;};
    button('ページ内を全選択',()=>this.selectAll(),false);
    button('選択を解除',()=>this.clear());
    button('コピー',()=>this.copy());this.pasteButton=button('貼り付け',()=>this.paste(),false);
    button('縮小 −10%',()=>this.transform(.9,0));button('拡大 ＋10%',()=>this.transform(1.1,0));
    button('左に15°回転',()=>this.transform(1,-Math.PI/12));button('右に15°回転',()=>this.transform(1,Math.PI/12));
    const directions=this.doc.createElement('div');directions.className='note-ink-lasso-directions';grid.append(directions);
    for(const [label,dx,dy]of [['←',-5,0],['↑',0,-5],['↓',0,5],['→',5,0]] as const){const b=button(label,()=>this.transform(1,0,dx,dy));b.setAttribute('aria-label',`${label} 選択した書き込みを移動`);directions.append(b);}
    button('選択した書き込みを削除',()=>this.remove()).classList.add('note-ink-lasso-delete');this.updateStatus();
    this.win.addEventListener('pointerdown',this.down,true);this.win.addEventListener('pointermove',this.move,true);
    this.win.addEventListener('pointerup',this.up,true);this.win.addEventListener('pointercancel',this.cancel,true);
    this.win.addEventListener('lostpointercapture',this.lostCapture,true);this.win.addEventListener('blur',this.cancel);this.doc.addEventListener('keydown',this.key,true);
    this.binding.viewer.container.addEventListener('scroll',this.cancel,{passive:true});
    // WebKit can emit touch gestures alongside Pencil pointer events.
    this.binding.viewer.container.addEventListener('touchstart',this.touch,{capture:true,passive:false});
    this.binding.viewer.container.addEventListener('touchmove',this.touch,{capture:true,passive:false});
    for(const name of viewerEvents)binding.eventBus.on(name,this.viewerChanged);
  }
  setEnabled(value:boolean):void{if(value===this.enabled)return;this.enabled=value;if(!value)this.clear();else this.updateStatus();}
  refresh():void{if(this.gesture)this.cancel();this.ids=new Set([...this.ids].filter(id=>this.controller.annotation.strokes.some(s=>s.id===id)));this.render();}
  destroy():void{
    this.clear();this.panel.remove();this.win.removeEventListener('pointerdown',this.down,true);this.win.removeEventListener('pointermove',this.move,true);
    this.win.removeEventListener('pointerup',this.up,true);this.win.removeEventListener('pointercancel',this.cancel,true);this.win.removeEventListener('lostpointercapture',this.lostCapture,true);this.win.removeEventListener('blur',this.cancel);
    this.doc.removeEventListener('keydown',this.key,true);this.binding.viewer.container.removeEventListener('scroll',this.cancel);
    this.binding.viewer.container.removeEventListener('touchstart',this.touch,true);this.binding.viewer.container.removeEventListener('touchmove',this.touch,true);
    for(const name of viewerEvents)this.binding.eventBus.off(name,this.viewerChanged);
  }
  private viewerChanged=():void=>{this.clear();};
  private local():InkStroke[]{return this.viewport?this.controller.annotation.strokes.filter(s=>this.ids.has(s.id)&&s.pageNumber===this.page?.id).map(s=>toViewportStroke(s,this.viewport!)):[];}
  private currentPage():NativePageView|null{const p=this.binding.viewer.getPageView(this.binding.viewer.currentPageNumber-1);return p?.pdfPage?p:null;}
  private usePage(page:NativePageView):void{
    if(this.page!==page){this.clear();this.page=page;}
    this.viewport=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});
  }
  private selectAll():void{const page=this.currentPage();if(!page)return;this.usePage(page);this.ids=new Set(this.controller.annotation.strokes.filter(s=>s.pageNumber===page.id).map(s=>s.id));this.render();}
  private clear():void{this.cancel();this.ids.clear();this.overlay?.remove();this.overlay=null;this.svg=null;this.preview=null;this.page=null;this.viewport=null;this.updateStatus();}
  private updateStatus():void{this.status.textContent=this.ids.size?`${this.ids.size}本の書き込みを選択中`:'投げ縄選択：書き込みを囲んでください';for(const b of this.selectionButtons){b.disabled=!this.ids.size;b.hidden=!this.ids.size;}const directions=this.panel.querySelector<HTMLElement>('.note-ink-lasso-directions');if(directions)directions.hidden=!this.ids.size;this.pasteButton.disabled=!this.clipboard.length;}
  private copy():void{if(!this.ids.size)return;this.clipboard=structuredClone(this.local());this.updateStatus();this.status.textContent='コピーしました。「貼り付け」で複製できます';}
  private paste():void{
    const page=this.currentPage();if(!this.clipboard.length||!page)return;this.usePage(page);
    const strokes=transformStrokes(this.clipboard,{x:0,y:0},12,12).map(s=>toPdfStroke({...s,id:crypto.randomUUID()},page.id,this.viewport!));
    this.ids=new Set(strokes.map(s=>s.id));this.controller.replaceStrokes([...this.controller.annotation.strokes,...strokes]);this.render();
  }
  private remove():void{if(!this.ids.size)return;const ids=new Set(this.ids);this.clear();this.controller.replaceStrokes(this.controller.annotation.strokes.filter(s=>!ids.has(s.id)));}
  private commit(strokes:InkStroke[]):void{
    if(!this.page||!this.viewport)return;const replacements=new Map(strokes.map(s=>[s.id,toPdfStroke(s,this.page!.id,this.viewport!)]));
    this.controller.replaceStrokes(this.controller.annotation.strokes.map(s=>replacements.get(s.id)??s));this.render();
  }
  private transform(scale:number,angle:number,dx=0,dy=0):void{const strokes=this.local(),b=strokeBounds(strokes);if(!b)return;this.commit(transformStrokes(strokes,{x:b.x+b.width/2,y:b.y+b.height/2},dx,dy,scale,angle));}
  private point(event:PointerEvent):Point{const r=this.page!.div.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width*this.viewport!.width,y:(event.clientY-r.top)/r.height*this.viewport!.height};}
  private down=(e:PointerEvent):void=>{
    if(!this.enabled)return;
    if(e.pointerType==='touch'){this.cancel();return;}
    if(!['pen','mouse'].includes(e.pointerType)||e.button!==0)return;
    const target=e.target as Element,div=target.closest?.('.page[data-page-number]');if(!div||!this.binding.viewer.viewer.contains(div))return;
    const page=this.binding.viewer.getPageView(Number((div as HTMLElement).dataset.pageNumber)-1);if(!page?.pdfPage)return;
    if(this.gesture){this.cancel();return;}
    this.usePage(page);const start=this.point(e),source=this.local(),bounds=strokeBounds(source);
    const handle=target.closest<HTMLElement>('[data-lasso-handle]')?.dataset.lassoHandle;
    const inBounds=bounds&&start.x>=bounds.x&&start.x<=bounds.x+bounds.width&&start.y>=bounds.y&&start.y<=bounds.y+bounds.height;
    const kind=handle==='scale'||handle==='rotate'?handle:inBounds?'move':'lasso';
    if(kind==='lasso')this.ids.clear();
    this.gesture={id:e.pointerId,kind,start,points:[start],source,bounds,changed:false};
    this.page!.div.classList.add('note-ink-pen-contact');this.doc.getSelection()?.removeAllRanges();
    try{this.page!.div.setPointerCapture(e.pointerId);}catch{/* Synthetic events have no native pointer. */}
    e.preventDefault();e.stopImmediatePropagation();this.render();
  };
  private transformed(g:Gesture,p:Point):InkStroke[]{
    const b=g.bounds!;const center={x:b.x+b.width/2,y:b.y+b.height/2};
    if(g.kind==='move')return transformStrokes(g.source,center,p.x-g.start.x,p.y-g.start.y);
    if(g.kind==='scale'){const initial=Math.hypot(g.start.x-center.x,g.start.y-center.y);return transformStrokes(g.source,center,0,0,Math.max(.05,Math.min(20,Math.hypot(p.x-center.x,p.y-center.y)/Math.max(1,initial))));}
    const angle=Math.atan2(p.y-center.y,p.x-center.x)-Math.atan2(g.start.y-center.y,g.start.x-center.x);return transformStrokes(g.source,center,0,0,1,angle);
  }
  private move=(e:PointerEvent):void=>{
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();
    const p=this.point(e);if(Math.hypot(p.x-g.start.x,p.y-g.start.y)>.5)g.changed=true;
    if(g.kind==='lasso'){const last=g.points[g.points.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)>.5)g.points.push(p);this.render();}
    else this.render(this.transformed(g,p));
  };
  private up=(e:PointerEvent):void=>{
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=this.point(e);
    this.endGesture();
    if(g.kind==='lasso'){
      g.points.push(p);this.ids=new Set(this.controller.annotation.strokes.filter(s=>s.pageNumber===this.page!.id&&lassoHits(toViewportStroke(s,this.viewport!),g.points)).map(s=>s.id));this.render();
    }else if(g.changed)this.commit(this.transformed(g,p));else this.render();
  };
  private endGesture():void{const g=this.gesture;this.gesture=null;this.page?.div.classList.remove('note-ink-pen-contact');if(g&&this.page?.div.hasPointerCapture(g.id))this.page.div.releasePointerCapture(g.id);this.showOriginal();}
  private lostCapture=(e:PointerEvent):void=>{if(this.gesture?.id===e.pointerId)this.cancel();};
  private cancel=():void=>{if(!this.gesture)return;this.endGesture();this.render();};
  private touch=(e:TouchEvent):void=>{if(!this.enabled)return;if(e.touches.length>1){this.cancel();return;}const t=e.changedTouches.item(0) as Touch&{touchType?:string}|null;if(t?.touchType==='stylus'&&this.gesture)e.preventDefault();};
  private showOriginal():void{this.page?.div.querySelector<HTMLElement>('.note-ink-native-overlay canvas')?.style.removeProperty('visibility');}
  private render(previewStrokes?:InkStroke[]):void{
    this.updateStatus();if(!this.page||!this.viewport)return;
    if(!this.overlay){this.overlay=this.doc.createElement('div');this.overlay.className='note-ink-lasso-overlay';this.svg=this.doc.createElementNS('http://www.w3.org/2000/svg','svg');this.svg.setAttribute('preserveAspectRatio','none');this.preview=this.doc.createElement('canvas');this.overlay.append(this.preview,this.svg);this.page.div.append(this.overlay);}
    const v=this.viewport;this.svg!.setAttribute('viewBox',`0 0 ${v.width} ${v.height}`);this.svg!.replaceChildren();this.overlay.querySelectorAll('button').forEach(b=>b.remove());
    this.preview!.hidden=!previewStrokes;
    if(previewStrokes){const replacements=new Map(previewStrokes.map(s=>[s.id,s]));const ctx=setupCanvas(this.preview!,v.width,v.height,{maxDpr:Math.min(3,this.page.viewport.scale*(this.win.devicePixelRatio||1)),maxPixels:2_000_000});this.preview!.style.width=this.preview!.style.height='100%';drawStrokes(ctx,this.controller.annotation.strokes.filter(s=>s.pageNumber===this.page!.id).map(s=>replacements.get(s.id)??toViewportStroke(s,v)));this.page.div.querySelector<HTMLElement>('.note-ink-native-overlay canvas')?.style.setProperty('visibility','hidden');}
    const shape=(tag:string,attributes:Record<string,string|number>)=>{const el=this.doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,val]of Object.entries(attributes))el.setAttribute(k,String(val));el.setAttribute('vector-effect','non-scaling-stroke');this.svg!.append(el);return el;};
    if(this.gesture?.kind==='lasso'){shape('polygon',{points:this.gesture.points.map(p=>`${p.x},${p.y}`).join(' '),class:'note-ink-lasso-path'});return;}
    const b=strokeBounds(previewStrokes??this.local());if(!b)return;
    shape('rect',{x:b.x,y:b.y,width:b.width,height:b.height,class:'note-ink-lasso-bounds'});
    const ratio=v.height/this.page.div.getBoundingClientRect().height,rotateY=Math.max(22*ratio,b.y-32*ratio);
    shape('line',{x1:b.x+b.width/2,y1:b.y,x2:b.x+b.width/2,y2:rotateY,class:'note-ink-lasso-bounds'});
    for(const [kind,label,x,y,symbol]of [['scale','選択した書き込みを拡大縮小',b.x+b.width,b.y+b.height,'↔'],['rotate','選択した書き込みを回転',b.x+b.width/2,rotateY,'↻']] as const){
      const handle=this.doc.createElement('button');handle.type='button';handle.className='note-ink-lasso-handle';handle.dataset.lassoHandle=kind;handle.setAttribute('aria-label',label);handle.title=label;handle.textContent=symbol;handle.style.left=`${x/v.width*100}%`;handle.style.top=`${y/v.height*100}%`;
      // The panel provides keyboard/tap alternatives; handles reserve Pencil/mouse dragging only.
      handle.tabIndex=-1;this.overlay.append(handle);
    }
  }
  private key=(e:KeyboardEvent):void=>{
    if(!this.enabled||!this.isActive()||(e.target as Element)?.closest?.('input,textarea,[contenteditable=true]'))return;
    const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
    if(mod&&['a','c','v'].includes(key)){e.preventDefault();e.stopImmediatePropagation();if(key==='a')this.selectAll();else if(key==='c')this.copy();else this.paste();return;}
    if(key==='escape'){e.preventDefault();if(this.gesture)this.cancel();else this.clear();return;}
    if(!this.ids.size)return;
    if(key==='delete'||key==='backspace'){e.preventDefault();e.stopImmediatePropagation();this.remove();return;}
    // Keep arrow-key navigation on toolbar controls intact.
    if((e.target as Element)?.closest?.('button'))return;
    const d:Record<string,Point>={arrowleft:{x:-1,y:0},arrowright:{x:1,y:0},arrowup:{x:0,y:-1},arrowdown:{x:0,y:1}};
    if(d[key]){e.preventDefault();e.stopImmediatePropagation();this.transform(1,0,d[key].x*(e.shiftKey?10:1),d[key].y*(e.shiftKey?10:1));}
  };
}
