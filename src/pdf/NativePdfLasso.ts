import { Menu, Notice, setIcon } from 'obsidian';
import type { InkStroke } from '../ink/types';
import { lassoHits, strokeBounds, transformStrokes, type Point, type Bounds } from '../ink/lasso';
import { drawStrokes, setupCanvas } from '../ink/renderer';
import { toPdfStroke, toViewportStroke, type PdfViewport } from './pdfCoordinates';
import type { NativePageView, NativePdfBinding } from './NativePdfViewer';
import type { NativePdfInkController } from './NativePdfInkController';

type Gesture={id:number;kind:'lasso'|'move'|'scale'|'rotate';start:Point;points:Point[];source:InkStroke[];bounds:Bounds|null;changed:boolean;corner?:string};
const viewerEvents=['scalechanging','rotationchanging','pagechanging'];
/** Selection is ephemeral. Only a finished gesture enters the existing save/history path. */
export class NativePdfLasso {
  private enabled=false;
  private page:NativePageView|null=null;
  private viewport:PdfViewport|null=null;
  private ids=new Set<string>();
  private gesture:Gesture|null=null;
  private overlay:HTMLDivElement|null=null;
  private svg:SVGSVGElement|null=null;
  private preview:HTMLCanvasElement|null=null;
  private clipboard:InkStroke[]=[];
  private hold:{id:number;page:NativePageView;x:number;y:number;timer:number}|null=null;
  private tap:{id:number;page:NativePageView;x:number;y:number}|null=null;
  private menu:Menu|null=null;
  private menuTime=0;
  private pasteLocation:{page:NativePageView;point:Point}|null=null;
  private readonly doc:Document;
  private readonly win:Window;
  constructor(private binding:NativePdfBinding,private controller:NativePdfInkController,private isActive:()=>boolean){
    this.doc=binding.viewer.container.ownerDocument;this.win=this.doc.defaultView!;
    this.win.addEventListener('pointerdown',this.down,true);this.win.addEventListener('pointermove',this.move,true);
    this.win.addEventListener('pointerup',this.up,true);this.win.addEventListener('pointercancel',this.cancel,true);
    this.win.addEventListener('lostpointercapture',this.lostCapture,true);this.win.addEventListener('blur',this.cancel);this.doc.addEventListener('keydown',this.key,true);
    this.binding.viewer.container.addEventListener('scroll',this.cancel,{passive:true});
    // WebKit can emit touch gestures alongside Pencil pointer events.
    this.binding.viewer.container.addEventListener('touchstart',this.touch,{capture:true,passive:false});
    this.binding.viewer.container.addEventListener('touchmove',this.touch,{capture:true,passive:false});
    binding.viewer.container.addEventListener('contextmenu',this.contextMenu,true);
    for(const name of viewerEvents)binding.eventBus.on(name,this.viewerChanged);
  }
  setEnabled(value:boolean):void{if(value===this.enabled)return;this.enabled=value;if(!value){this.clear();this.menu?.hide();}}
  refresh():void{if(this.gesture)this.cancel();this.ids=new Set([...this.ids].filter(id=>this.controller.annotation.strokes.some(s=>s.id===id)));this.render();}
  destroy():void{
    this.clear();this.menu?.hide();this.win.removeEventListener('pointerdown',this.down,true);this.win.removeEventListener('pointermove',this.move,true);
    this.win.removeEventListener('pointerup',this.up,true);this.win.removeEventListener('pointercancel',this.cancel,true);this.win.removeEventListener('lostpointercapture',this.lostCapture,true);this.win.removeEventListener('blur',this.cancel);
    this.doc.removeEventListener('keydown',this.key,true);this.binding.viewer.container.removeEventListener('scroll',this.cancel);
    this.binding.viewer.container.removeEventListener('touchstart',this.touch,true);this.binding.viewer.container.removeEventListener('touchmove',this.touch,true);
    this.binding.viewer.container.removeEventListener('contextmenu',this.contextMenu,true);
    for(const name of viewerEvents)this.binding.eventBus.off(name,this.viewerChanged);
  }
  private viewerChanged=():void=>{this.clear();this.menu?.hide();this.pasteLocation=null;};
  private local():InkStroke[]{return this.viewport?this.controller.annotation.strokes.filter(s=>this.ids.has(s.id)&&s.pageNumber===this.page?.id).map(s=>toViewportStroke(s,this.viewport!)):[];}
  private interactiveBounds(b:Bounds|null):Bounds|null{
    if(!b||!this.page||!this.viewport)return b;const r=this.page.div.getBoundingClientRect();
    const width=Math.max(b.width,44*this.viewport.width/r.width),height=Math.max(b.height,44*this.viewport.height/r.height);
    return {x:b.x-(width-b.width)/2,y:b.y-(height-b.height)/2,width,height};
  }
  private currentPage():NativePageView|null{const p=this.binding.viewer.getPageView(this.binding.viewer.currentPageNumber-1);return p?.pdfPage?p:null;}
  private usePage(page:NativePageView):void{
    if(this.page!==page){this.clear();this.page=page;}
    this.viewport=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});
  }
  private clear():void{this.cancel();this.ids.clear();this.overlay?.remove();this.overlay=null;this.svg=null;this.preview=null;this.page=null;this.viewport=null;}
  private copy():void{if(!this.ids.size)return;this.clipboard=structuredClone(this.local());new Notice('コピーしました。貼り付けたい場所を長押ししてください。');}
  private paste(page:NativePageView,point:Point):void{
    if(!this.clipboard.length||!page.pdfPage||!page.div.isConnected||this.binding.viewer.pdfDocument!==this.binding.pdf)return;
    this.usePage(page);const bounds=strokeBounds(this.clipboard)!;
    const strokes=transformStrokes(this.clipboard,{x:0,y:0},point.x-bounds.x-bounds.width/2,point.y-bounds.y-bounds.height/2).map(s=>toPdfStroke({...s,id:crypto.randomUUID()},page.id,this.viewport!));
    this.ids=new Set(strokes.map(s=>s.id));this.controller.replaceStrokes([...this.controller.annotation.strokes,...strokes]);this.render();
  }
  private pageFor(target:EventTarget|null):NativePageView|null{
    const div=(target as Element)?.closest?.('.page[data-page-number]');if(!div||!this.binding.viewer.viewer.contains(div))return null;
    const page=this.binding.viewer.getPageView(Number((div as HTMLElement).dataset.pageNumber)-1);return page?.pdfPage?page:null;
  }
  private pointAt(page:NativePageView,x:number,y:number):Point{const r=page.div.getBoundingClientRect(),v=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});return {x:(x-r.left)/r.width*v.width,y:(y-r.top)/r.height*v.height};}
  private showMenu(page:NativePageView,x:number,y:number):void{
    if(!this.clipboard.length)return;
    this.doc.getSelection()?.removeAllRanges();const point=this.pointAt(page,x,y);this.pasteLocation={page,point};this.cancel();this.menu?.hide();
    const menu=new Menu();this.menu=menu;this.menuTime=Date.now();
    menu.addItem(item=>item.setTitle('貼り付け').setIcon('clipboard-paste').onClick(()=>{if(this.enabled)this.paste(page,point);}));
    menu.showAtPosition({x,y});
  }
  private contextMenu=(e:MouseEvent):void=>{
    if(!this.enabled||!this.clipboard.length)return;const page=this.pageFor(e.target);if(!page)return;
    e.preventDefault();e.stopImmediatePropagation();
    // iPad may fire a native contextmenu after our long-press timer has opened it.
    if(Date.now()-this.menuTime>800)this.showMenu(page,e.clientX,e.clientY);
  };
  private startHold(e:PointerEvent,page:NativePageView):void{
    this.stopHold();if(!this.clipboard.length)return;
    const {pointerId:id,clientX:x,clientY:y}=e;
    this.hold={id,page,x,y,timer:this.win.setTimeout(()=>{this.hold=null;this.tap=null;this.showMenu(page,x,y);},550)};
  }
  private stopHold():void{if(this.hold)this.win.clearTimeout(this.hold.timer);this.hold=null;}
  private remove():void{if(!this.ids.size)return;const ids=new Set(this.ids);this.clear();this.controller.replaceStrokes(this.controller.annotation.strokes.filter(s=>!ids.has(s.id)));}
  private commit(strokes:InkStroke[]):void{
    if(!this.page||!this.viewport)return;const replacements=new Map(strokes.map(s=>[s.id,toPdfStroke(s,this.page!.id,this.viewport!)]));
    this.controller.replaceStrokes(this.controller.annotation.strokes.map(s=>replacements.get(s.id)??s));this.render();
  }
  private transform(scale:number,angle:number,dx=0,dy=0):void{const strokes=this.local(),b=strokeBounds(strokes);if(!b)return;this.commit(transformStrokes(strokes,{x:b.x+b.width/2,y:b.y+b.height/2},dx,dy,scale,angle));}
  private point(event:PointerEvent):Point{const r=this.page!.div.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width*this.viewport!.width,y:(event.clientY-r.top)/r.height*this.viewport!.height};}
  private down=(e:PointerEvent):void=>{
    if(!this.enabled||!['pen','mouse','touch'].includes(e.pointerType)||e.button!==0)return;
    if(this.gesture||this.tap){this.cancel();return;}
    const page=this.pageFor(e.target);if(!page)return;
    const target=e.target as Element,action=target.closest<HTMLElement>('[data-lasso-action]');
    if(action)return; // Real buttons handle copy/delete without starting a drag.
    const handle=target.closest<HTMLElement>('[data-lasso-handle]')?.dataset.lassoHandle;
    const start=this.pointAt(page,e.clientX,e.clientY),source=page===this.page?this.local():[],bounds=this.interactiveBounds(strokeBounds(source));
    const inBounds=bounds&&start.x>=bounds.x&&start.x<=bounds.x+bounds.width&&start.y>=bounds.y&&start.y<=bounds.y+bounds.height;
    this.pasteLocation={page,point:start};
    if(e.pointerType==='touch'&&!handle&&!inBounds){
      // Outside the selection, fingers retain native scrolling/pinching; a tap clears it.
      this.tap={id:e.pointerId,page,x:e.clientX,y:e.clientY};this.startHold(e,page);return;
    }
    this.usePage(page);if(!handle)this.startHold(e,page);
    const kind=handle?.startsWith('scale-')?'scale':handle==='rotate'?'rotate':inBounds?'move':'lasso';
    this.gesture={id:e.pointerId,kind,start,points:[start],source,bounds,changed:false,corner:handle};
    this.page!.div.classList.add('note-ink-pen-contact');this.doc.getSelection()?.removeAllRanges();
    try{this.page!.div.setPointerCapture(e.pointerId);}catch{/* Synthetic events have no native pointer. */}
    e.preventDefault();e.stopImmediatePropagation();
  };
  private transformed(g:Gesture,p:Point):InkStroke[]{
    const b=g.bounds!;const center={x:b.x+b.width/2,y:b.y+b.height/2};
    if(g.kind==='move')return transformStrokes(g.source,center,p.x-g.start.x,p.y-g.start.y);
    if(g.kind==='scale'){
      const left=g.corner?.endsWith('nw')||g.corner?.endsWith('sw'),top=g.corner?.endsWith('nw')||g.corner?.endsWith('ne');
      const anchor={x:left?b.x+b.width:b.x,y:top?b.y+b.height:b.y},dx=g.start.x-anchor.x,dy=g.start.y-anchor.y;
      const scale=Math.max(.05,Math.min(20,((p.x-anchor.x)*dx+(p.y-anchor.y)*dy)/Math.max(1,dx*dx+dy*dy)));
      return transformStrokes(g.source,anchor,0,0,scale);
    }
    const angle=Math.atan2(p.y-center.y,p.x-center.x)-Math.atan2(g.start.y-center.y,g.start.x-center.x);return transformStrokes(g.source,center,0,0,1,angle);
  }
  private move=(e:PointerEvent):void=>{
    const candidate=this.hold??this.tap;if(candidate&&candidate.id===e.pointerId&&Math.hypot(e.clientX-candidate.x,e.clientY-candidate.y)>8){this.stopHold();this.tap=null;}
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();
    const p=this.point(e);if(Math.hypot(p.x-g.start.x,p.y-g.start.y)*this.page!.div.getBoundingClientRect().width/this.viewport!.width>5)g.changed=true;
    if(!g.changed)return;this.stopHold();
    if(g.kind==='lasso'){if(g.changed)this.ids.clear();const last=g.points[g.points.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)>.5)g.points.push(p);this.render();}
    else this.render(this.transformed(g,p));
  };
  private up=(e:PointerEvent):void=>{
    this.stopHold();if(this.tap?.id===e.pointerId){this.tap=null;this.clear();return;}
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=this.point(e);
    this.endGesture();
    if(g.kind==='lasso'){
      if(!g.changed){this.clear();return;}
      g.points.push(p);this.ids=new Set(this.controller.annotation.strokes.filter(s=>s.pageNumber===this.page!.id&&lassoHits(toViewportStroke(s,this.viewport!),g.points)).map(s=>s.id));this.render();
    }else if(g.changed)this.commit(this.transformed(g,p));else this.render();
  };
  private endGesture():void{const g=this.gesture;this.gesture=null;this.page?.div.classList.remove('note-ink-pen-contact');if(g&&this.page?.div.hasPointerCapture(g.id))this.page.div.releasePointerCapture(g.id);this.showOriginal();}
  private lostCapture=(e:PointerEvent):void=>{if(this.gesture?.id===e.pointerId)this.cancel();};
  private cancel=():void=>{this.stopHold();this.tap=null;if(!this.gesture)return;this.endGesture();this.render();};
  private touch=(e:TouchEvent):void=>{if(!this.enabled)return;if(e.touches.length>1){this.cancel();return;}const t=e.changedTouches.item(0) as Touch&{touchType?:string}|null;if(t?.touchType==='stylus'&&this.gesture)e.preventDefault();};
  private showOriginal():void{this.page?.div.classList.remove('note-ink-lasso-transforming');this.page?.div.querySelector<HTMLElement>('.note-ink-native-overlay canvas')?.style.removeProperty('visibility');}
  private render(previewStrokes?:InkStroke[]):void{
    if(!this.page||!this.viewport)return;
    if(!this.overlay){this.overlay=this.doc.createElement('div');this.overlay.className='note-ink-lasso-overlay';this.svg=this.doc.createElementNS('http://www.w3.org/2000/svg','svg');this.svg.setAttribute('preserveAspectRatio','none');this.preview=this.doc.createElement('canvas');this.overlay.append(this.preview,this.svg);this.page.div.append(this.overlay);}
    const v=this.viewport;this.svg!.setAttribute('viewBox',`0 0 ${v.width} ${v.height}`);this.svg!.replaceChildren();const focused=(this.doc.activeElement as HTMLElement)?.dataset?.lassoHandle,focusedMove=this.doc.activeElement?.classList.contains('note-ink-lasso-move');this.overlay.querySelectorAll('button,.note-ink-lasso-move').forEach(b=>b.remove());
    this.preview!.hidden=!previewStrokes;
    if(previewStrokes){this.page.div.classList.add('note-ink-lasso-transforming');const replacements=new Map(previewStrokes.map(s=>[s.id,s]));const ctx=setupCanvas(this.preview!,v.width,v.height,{maxDpr:Math.min(3,this.page.viewport.scale*(this.win.devicePixelRatio||1)),maxPixels:2_000_000});this.preview!.style.width=this.preview!.style.height='100%';drawStrokes(ctx,this.controller.annotation.strokes.filter(s=>s.pageNumber===this.page!.id).map(s=>replacements.get(s.id)??toViewportStroke(s,v)));this.page.div.querySelector<HTMLElement>('.note-ink-native-overlay canvas')?.style.setProperty('visibility','hidden');}
    const shape=(tag:string,attributes:Record<string,string|number>)=>{const el=this.doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,val]of Object.entries(attributes))el.setAttribute(k,String(val));el.setAttribute('vector-effect','non-scaling-stroke');this.svg!.append(el);return el;};
    if(this.gesture?.kind==='lasso'){shape('polygon',{points:this.gesture.points.map(p=>`${p.x},${p.y}`).join(' '),class:'note-ink-lasso-path'});return;}
    const b=this.interactiveBounds(strokeBounds(previewStrokes??this.local()));if(!b)return;
    shape('rect',{x:b.x,y:b.y,width:b.width,height:b.height,class:'note-ink-lasso-bounds'});
    const r=this.page.div.getBoundingClientRect(),rx=v.width/r.width,ry=v.height/r.height;
    const move=this.doc.createElement('div');move.className='note-ink-lasso-move';move.tabIndex=0;move.setAttribute('role','group');move.setAttribute('aria-label','選択した書き込み：ドラッグまたは矢印キーで移動');
    Object.assign(move.style,{left:`${b.x/v.width*100}%`,top:`${b.y/v.height*100}%`,width:`${b.width/v.width*100}%`,height:`${b.height/v.height*100}%`});this.overlay.append(move);if(focusedMove)move.focus({preventScroll:true});
    const actionX=Math.max(70*rx,Math.min(v.width-70*rx,b.x+b.width/2)),actionY=Math.max(24*ry,b.y-38*ry);
    shape('line',{x1:b.x+b.width/2,y1:b.y,x2:actionX,y2:actionY,class:'note-ink-lasso-bounds'});
    const button=(kind:string,label:string,x:number,y:number,icon:string,action?:()=>void)=>{
      const h=this.doc.createElement('button');h.type='button';h.className='note-ink-lasso-handle';
      if(action){h.dataset.lassoAction=kind;h.onclick=e=>{e.stopPropagation();action();};}else h.dataset.lassoHandle=kind;
      h.setAttribute('aria-label',label);h.title=label;setIcon(h,icon);h.style.left=`${x/v.width*100}%`;h.style.top=`${y/v.height*100}%`;this.overlay!.append(h);
      if(kind.startsWith('scale'))h.classList.add('note-ink-lasso-corner');
      if(focused===kind)h.focus({preventScroll:true});
    };
    for(const [corner,label,x,y]of [['nw','左上',b.x,b.y],['ne','右上',b.x+b.width,b.y],['sw','左下',b.x,b.y+b.height],['se','右下',b.x+b.width,b.y+b.height]] as const)
      button(`scale-${corner}`,`${label}：ドラッグで拡大縮小・矢印キーでも操作`,x,y,'');
    button('rotate','回転：ドラッグまたは左右キーで操作',actionX,actionY,'rotate-cw');
    button('copy','選択した書き込みをコピー',actionX-46*rx,actionY,'copy',()=>this.copy());
    button('delete','選択した書き込みを削除',actionX+46*rx,actionY,'trash-2',()=>this.remove());
  }
  private key=(e:KeyboardEvent):void=>{
    if(!this.enabled||!this.isActive()||(e.target as Element)?.closest?.('input,textarea,[contenteditable=true]'))return;
    const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
    if(mod&&['c','v'].includes(key)){e.preventDefault();e.stopImmediatePropagation();if(key==='c')this.copy();else {const location=this.pasteLocation;const page=location?.page??this.currentPage();if(page){const v=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});this.paste(page,location?.point??{x:v.width/2,y:v.height/2});}}return;}
    const handle=(e.target as HTMLElement)?.dataset?.lassoHandle;
    if(handle&&['arrowleft','arrowright','arrowup','arrowdown'].includes(key)){e.preventDefault();e.stopImmediatePropagation();const positive=key==='arrowright'||key==='arrowup';this.transform(handle.startsWith('scale')?(positive?1.1:.9):1,handle==='rotate'?(positive?1:-1)*Math.PI/12:0);return;}
    if(key==='escape'){e.preventDefault();if(this.gesture)this.cancel();else this.clear();return;}
    if(!this.ids.size)return;
    if(key==='delete'||key==='backspace'){e.preventDefault();e.stopImmediatePropagation();this.remove();return;}
    // Keep arrow-key navigation on toolbar controls intact.
    if((e.target as Element)?.closest?.('button'))return;
    const d:Record<string,Point>={arrowleft:{x:-1,y:0},arrowright:{x:1,y:0},arrowup:{x:0,y:-1},arrowdown:{x:0,y:1}};
    if(d[key]){e.preventDefault();e.stopImmediatePropagation();this.transform(1,0,d[key].x*(e.shiftKey?10:1),d[key].y*(e.shiftKey?10:1));}
  };
}
