import { Menu, Notice, setIcon } from 'obsidian';
import type { InkStroke } from '../ink/types';
import { lassoHits, strokeBounds, transformStrokes, snapRotation, type Point, type Bounds } from '../ink/lasso';
import { visibleInkBounds } from '../ink/visibleBounds';
import { drawStrokes, setupCanvas } from '../ink/renderer';
import { toPdfStroke, toViewportStroke, type PdfViewport } from './pdfCoordinates';
import type { NativePageView, NativePdfBinding } from './NativePdfViewer';
import type { NativePdfInkController } from './NativePdfInkController';

type Frame={center:Point;width:number;height:number;angle:number};
type Transform={center:Point;dx:number;dy:number;scale:number;angle:number};
type Gesture={id:number;kind:'lasso'|'move'|'scale'|'rotate';start:Point;points:Point[];source:InkStroke[];changed:boolean;corner?:string;frame:Frame|null;rect:DOMRect;latest:Point;snap?:number|null;rotation?:number};
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
  private backdrop:HTMLCanvasElement|null=null;
  private frame:Frame|null=null;
  private ownCommit=false;
  private animation:number|null=null;
  private previewReady=false;
  private previewOrigin:Point={x:0,y:0};
  readonly diagnostics={previewBuilds:0,previewFrames:0,geometryCommits:0};
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
  refresh():void{if(this.ownCommit)return;this.frame=null;if(this.gesture)this.cancel();this.ids=new Set([...this.ids].filter(id=>this.controller.annotation.strokes.some(s=>s.id===id)));this.render();}
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
    const px=3*this.viewport.width/r.width,py=3*this.viewport.height/r.height;
    return {x:b.x-px,y:b.y-py,width:b.width+px*2,height:b.height+py*2};
  }
  private currentPage():NativePageView|null{const p=this.binding.viewer.getPageView(this.binding.viewer.currentPageNumber-1);return p?.pdfPage?p:null;}
  private usePage(page:NativePageView):void{
    if(this.page!==page){this.clear();this.page=page;}
    this.viewport=page.pdfPage!.getViewport({scale:1,rotation:page.viewport.rotation});
  }
  private clear():void{this.cancel();this.ids.clear();this.overlay?.remove();this.overlay=null;this.svg=null;this.preview=null;this.backdrop=null;this.frame=null;this.page=null;this.viewport=null;}
  private copy():void{if(!this.ids.size)return;this.clipboard=structuredClone(this.local());new Notice('コピーしました。貼り付けたい場所を長押ししてください。');}
  private paste(page:NativePageView,point:Point):void{
    if(!this.clipboard.length||!page.pdfPage||!page.div.isConnected||this.binding.viewer.pdfDocument!==this.binding.pdf)return;
    this.usePage(page);const bounds=visibleInkBounds(this.clipboard,this.doc);if(!bounds)return;
    const strokes=transformStrokes(this.clipboard,{x:0,y:0},point.x-bounds.x-bounds.width/2,point.y-bounds.y-bounds.height/2).map(s=>toPdfStroke({...s,id:crypto.randomUUID()},page.id,this.viewport!));
    this.frame=null;this.ids=new Set(strokes.map(s=>s.id));this.controller.replaceStrokes([...this.controller.annotation.strokes,...strokes]);this.render();
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
    this.ownCommit=true;try{this.controller.replaceStrokes(this.controller.annotation.strokes.map(s=>replacements.get(s.id)??s));this.diagnostics.geometryCommits++;}finally{this.ownCommit=false;}this.render();
  }
  private transform(scale:number,angle:number,dx=0,dy=0):void{
    const strokes=this.local();if(!this.frame||!strokes.length)return;
    const t={center:this.frame.center,dx,dy,scale,angle};this.frame=this.transformedFrame(this.frame,t);this.commit(transformStrokes(strokes,t.center,dx,dy,scale,angle));
  }
  private point(event:PointerEvent):Point{const r=this.gesture?.rect??this.page!.div.getBoundingClientRect();return {x:(event.clientX-r.left)/r.width*this.viewport!.width,y:(event.clientY-r.top)/r.height*this.viewport!.height};}
  private framePoint(frame:Frame,x:number,y:number):Point{const c=Math.cos(frame.angle),s=Math.sin(frame.angle);return {x:frame.center.x+x*c-y*s,y:frame.center.y+x*s+y*c};}
  private contains(frame:Frame|null,p:Point):boolean{if(!frame)return false;const c=Math.cos(frame.angle),s=Math.sin(frame.angle),x=p.x-frame.center.x,y=p.y-frame.center.y;return Math.abs(x*c+y*s)<=frame.width/2&&Math.abs(-x*s+y*c)<=frame.height/2;}
  private transformedFrame(frame:Frame,t:Transform):Frame{const c=Math.cos(t.angle),s=Math.sin(t.angle),x=frame.center.x-t.center.x,y=frame.center.y-t.center.y;return {center:{x:t.center.x+t.dx+t.scale*(x*c-y*s),y:t.center.y+t.dy+t.scale*(x*s+y*c)},width:frame.width*t.scale,height:frame.height*t.scale,angle:frame.angle+t.angle};}
  private down=(e:PointerEvent):void=>{
    if(!this.enabled||!['pen','mouse','touch'].includes(e.pointerType)||e.button!==0)return;
    if(this.gesture||this.tap){this.cancel();return;}
    const page=this.pageFor(e.target);if(!page)return;
    const target=e.target as Element,action=target.closest<HTMLElement>('[data-lasso-action]');
    if(action)return; // Real buttons handle copy/delete without starting a drag.
    const handle=target.closest<HTMLElement>('[data-lasso-handle]')?.dataset.lassoHandle;
    const start=this.pointAt(page,e.clientX,e.clientY),source=page===this.page?this.local():[];
    const inBounds=page===this.page&&this.contains(this.frame,start);
    this.pasteLocation={page,point:start};
    if(e.pointerType==='touch'&&!handle&&!inBounds){
      // Outside the selection, fingers retain native scrolling/pinching; a tap clears it.
      this.tap={id:e.pointerId,page,x:e.clientX,y:e.clientY};this.startHold(e,page);return;
    }
    this.usePage(page);if(!handle)this.startHold(e,page);
    const kind=handle?.startsWith('scale-')?'scale':handle==='rotate'?'rotate':inBounds?'move':'lasso';
    this.gesture={id:e.pointerId,kind,start,points:[start],source,changed:false,corner:handle,frame:this.frame?structuredClone(this.frame):null,rect:page.div.getBoundingClientRect(),latest:start};
    this.page!.div.classList.add('note-ink-pen-contact');this.doc.getSelection()?.removeAllRanges();
    try{this.page!.div.setPointerCapture(e.pointerId);}catch{/* Synthetic events have no native pointer. */}
    e.preventDefault();e.stopImmediatePropagation();
  };
  private transformation(g:Gesture,p:Point):Transform{
    const f=g.frame!,center=f.center;
    if(g.kind==='move')return {center,dx:p.x-g.start.x,dy:p.y-g.start.y,scale:1,angle:0};
    if(g.kind==='scale'){
      const left=g.corner?.endsWith('nw')||g.corner?.endsWith('sw'),top=g.corner?.endsWith('nw')||g.corner?.endsWith('ne');
      const anchor=this.framePoint(f,left?f.width/2:-f.width/2,top?f.height/2:-f.height/2),dx=g.start.x-anchor.x,dy=g.start.y-anchor.y;
      const scale=Math.max(.05,Math.min(20,((p.x-anchor.x)*dx+(p.y-anchor.y)*dy)/Math.max(1,dx*dx+dy*dy)));
      return {center:anchor,dx:0,dy:0,scale,angle:0};
    }
    let raw=f.angle+Math.atan2(p.y-center.y,p.x-center.x)-Math.atan2(g.start.y-center.y,g.start.x-center.x);
    raw+=Math.round(((g.rotation??f.angle)-raw)/(2*Math.PI))*2*Math.PI;g.rotation=raw;
    const snapped=snapRotation(raw,g.snap??null);g.snap=snapped.locked;
    return {center,dx:0,dy:0,scale:1,angle:snapped.angle-f.angle};
  }
  private schedulePreview():void{
    if(this.animation!==null)return;
    this.animation=this.win.requestAnimationFrame(()=>{this.animation=null;const g=this.gesture;if(!g)return;
      if(g.kind==='lasso')this.renderLasso(g);else this.previewTransform(g,this.transformation(g,g.latest));
    });
  }
  private renderLasso(g:Gesture):void{
    this.ensureOverlay();let path=this.svg!.querySelector('.note-ink-lasso-path');
    if(!path){this.svg!.replaceChildren();this.overlay!.querySelectorAll('button,.note-ink-lasso-move').forEach(e=>e.remove());path=this.doc.createElementNS('http://www.w3.org/2000/svg','polygon');path.setAttribute('class','note-ink-lasso-path');path.setAttribute('vector-effect','non-scaling-stroke');this.svg!.append(path);}
    path.setAttribute('points',g.points.map(p=>`${p.x},${p.y}`).join(' '));
  }
  private ensureOverlay():void{
    if(this.overlay||!this.page||!this.viewport)return;
    this.overlay=this.doc.createElement('div');this.overlay.className='note-ink-lasso-overlay';
    this.svg=this.doc.createElementNS('http://www.w3.org/2000/svg','svg');this.svg.setAttribute('preserveAspectRatio','none');this.svg.setAttribute('viewBox',`0 0 ${this.viewport.width} ${this.viewport.height}`);
    this.backdrop=this.doc.createElement('canvas');this.preview=this.doc.createElement('canvas');this.backdrop.hidden=this.preview.hidden=true;
    this.overlay.append(this.backdrop,this.preview,this.svg);this.page.div.append(this.overlay);
  }
  private preparePreview(g:Gesture):void{
    this.ensureOverlay();const v=this.viewport!,page=this.page!;
    const options={maxDpr:Math.min(3,page.viewport.scale*(this.win.devicePixelRatio||1)),maxPixels:2_000_000};
    const background=setupCanvas(this.backdrop!,v.width,v.height,options);this.backdrop!.style.width=this.backdrop!.style.height='100%';
    drawStrokes(background,this.controller.annotation.strokes.filter(s=>s.pageNumber===page.id&&!this.ids.has(s.id)).map(s=>toViewportStroke(s,v)));
    const b=strokeBounds(g.source)!;let pad=2;for(const s of g.source)pad=Math.max(pad,s.width*2);
    const x=b.x-pad,y=b.y-pad,w=b.width+pad*2,h=b.height+pad*2;this.previewOrigin={x,y};
    const selected=setupCanvas(this.preview!,w,h,options);selected.translate(-x,-y);drawStrokes(selected,g.source);
    Object.assign(this.preview!.style,{width:`${w/v.width*100}%`,height:`${h/v.height*100}%`,left:`${x/v.width*100}%`,top:`${y/v.height*100}%`,transformOrigin:'0 0',willChange:'transform'});
    this.backdrop!.hidden=this.preview!.hidden=false;page.div.classList.add('note-ink-lasso-transforming');this.previewReady=true;this.diagnostics.previewBuilds++;
  }
  private previewTransform(g:Gesture,t:Transform):void{
    if(!this.previewReady)this.preparePreview(g);
    const a=t.scale*Math.cos(t.angle),b=t.scale*Math.sin(t.angle),c=-b,d=a;
    const e=t.center.x+t.dx-a*t.center.x-c*t.center.y,f=t.center.y+t.dy-b*t.center.x-d*t.center.y;
    const o=this.previewOrigin,sx=g.rect.width/this.viewport!.width,sy=g.rect.height/this.viewport!.height;
    this.preview!.style.transform=`matrix(${a},${b*sy/sx},${c*sx/sy},${d},${(a*o.x+c*o.y+e-o.x)*sx},${(b*o.x+d*o.y+f-o.y)*sy})`;
    this.updateFrame(this.transformedFrame(g.frame!,t),g.rect);this.diagnostics.previewFrames++;
  }
  private move=(e:PointerEvent):void=>{
    const candidate=this.hold??this.tap;if(candidate&&candidate.id===e.pointerId&&Math.hypot(e.clientX-candidate.x,e.clientY-candidate.y)>8){this.stopHold();this.tap=null;}
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();
    const p=this.point(e);if(Math.hypot(p.x-g.start.x,p.y-g.start.y)*g.rect.width/this.viewport!.width>5)g.changed=true;
    if(!g.changed)return;this.stopHold();
    g.latest=p;if(g.kind==='lasso'){this.ids.clear();this.frame=null;const last=g.points[g.points.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)>1)g.points.push(p);}
    this.schedulePreview();
  };
  private up=(e:PointerEvent):void=>{
    this.stopHold();if(this.tap?.id===e.pointerId){this.tap=null;this.clear();return;}
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=this.point(e);
    this.endGesture();
    if(g.kind==='lasso'){
      if(!g.changed){this.clear();return;}
      g.points.push(p);this.ids=new Set(this.controller.annotation.strokes.filter(s=>s.pageNumber===this.page!.id&&lassoHits(toViewportStroke(s,this.viewport!),g.points)).map(s=>s.id));this.render();
    }else if(g.changed){const t=this.transformation(g,p);this.frame=this.transformedFrame(g.frame!,t);this.commit(transformStrokes(g.source,t.center,t.dx,t.dy,t.scale,t.angle));}else this.render();
  };
  private endGesture():void{if(this.animation!==null)this.win.cancelAnimationFrame(this.animation);this.animation=null;const g=this.gesture;this.gesture=null;this.page?.div.classList.remove('note-ink-pen-contact');if(g&&this.page?.div.hasPointerCapture(g.id))this.page.div.releasePointerCapture(g.id);this.showOriginal();}
  private lostCapture=(e:PointerEvent):void=>{if(this.gesture?.id===e.pointerId)this.cancel();};
  private cancel=():void=>{this.stopHold();this.tap=null;if(!this.gesture)return;this.endGesture();this.render();};
  private touch=(e:TouchEvent):void=>{if(!this.enabled)return;if(e.touches.length>1){this.cancel();return;}const t=e.changedTouches.item(0) as Touch&{touchType?:string}|null;if(t?.touchType==='stylus'&&this.gesture)e.preventDefault();};
  private showOriginal():void{
    this.page?.div.classList.remove('note-ink-lasso-transforming');this.previewReady=false;
    for(const canvas of [this.preview,this.backdrop])if(canvas){canvas.hidden=true;canvas.width=canvas.height=0;canvas.style.transform='';canvas.style.willChange='';}
  }
  private render():void{
    if(!this.page||!this.viewport)return;this.ensureOverlay();
    const b=this.frame?null:this.interactiveBounds(visibleInkBounds(this.local(),this.doc));
    if(b)this.frame={center:{x:b.x+b.width/2,y:b.y+b.height/2},width:b.width,height:b.height,angle:0};
    if(!this.frame)this.ids.clear();
    if(!this.frame||!this.ids.size){this.svg!.replaceChildren();this.overlay!.querySelectorAll('button,.note-ink-lasso-move').forEach(e=>e.remove());return;}
    if(!this.svg!.querySelector('.note-ink-lasso-bounds')){
      this.svg!.replaceChildren();
      for(const tag of ['polygon','line']){const el=this.doc.createElementNS('http://www.w3.org/2000/svg',tag);el.setAttribute('class','note-ink-lasso-bounds');el.setAttribute('vector-effect','non-scaling-stroke');this.svg!.append(el);}
      const move=this.doc.createElement('div');move.className='note-ink-lasso-move';move.tabIndex=0;move.setAttribute('role','group');move.setAttribute('aria-label','選択した書き込み：ドラッグまたは矢印キーで移動');this.overlay!.append(move);
      const button=(kind:string,label:string,icon:string,action?:()=>void)=>{
        const h=this.doc.createElement('button');h.type='button';h.className='note-ink-lasso-handle';
        if(action){h.dataset.lassoAction=kind;h.onclick=e=>{e.stopPropagation();action();};}else h.dataset.lassoHandle=kind;
        h.setAttribute('aria-label',label);h.title=label;if(icon)setIcon(h,icon);this.overlay!.append(h);
        if(kind.startsWith('scale'))h.classList.add('note-ink-lasso-corner');
      };
      for(const [corner,label]of [['nw','左上'],['ne','右上'],['sw','左下'],['se','右下']])button(`scale-${corner}`,`${label}：ドラッグで拡大縮小・矢印キーでも操作`,'');
      button('rotate','回転：ドラッグまたは左右キーで操作','rotate-cw');
      button('copy','選択した書き込みをコピー','copy',()=>this.copy());button('delete','選択した書き込みを削除','trash-2',()=>this.remove());
    }
    this.updateFrame(this.frame,this.page.div.getBoundingClientRect());
  }
  private updateFrame(frame:Frame,r:DOMRect):void{
    const v=this.viewport!,overlay=this.overlay!,points=[[-1,-1],[1,-1],[-1,1],[1,1]].map(([x,y])=>this.framePoint(frame,x*frame.width/2,y*frame.height/2));
    this.svg!.querySelector('polygon')!.setAttribute('points',[points[0],points[1],points[3],points[2]].map(p=>`${p.x},${p.y}`).join(' '));
    const move=overlay.querySelector<HTMLElement>('.note-ink-lasso-move')!;
    Object.assign(move.style,{left:`${(frame.center.x-frame.width/2)/v.width*100}%`,top:`${(frame.center.y-frame.height/2)/v.height*100}%`,width:`${frame.width/v.width*100}%`,height:`${frame.height/v.height*100}%`,transform:`rotate(${frame.angle}rad)`});
    const position=(el:HTMLElement,p:Point)=>{el.style.left=`${p.x/v.width*100}%`;el.style.top=`${p.y/v.height*100}%`;};
    ['nw','ne','sw','se'].forEach((corner,i)=>{const h=overlay.querySelector<HTMLElement>(`[data-lasso-handle="scale-${corner}"]`)!;position(h,points[i]);h.style.setProperty('--lasso-angle',`${frame.angle}rad`);const size=Math.min(28,Math.max(12,Math.min(frame.width*r.width/v.width,frame.height*r.height/v.height)));h.style.width=h.style.height=h.style.minWidth=`${size}px`;});
    const top=this.framePoint(frame,0,-frame.height/2),action=this.framePoint(frame,0,-frame.height/2-38*v.height/r.height);
    const line=this.svg!.querySelector('line')!;for(const [key,value]of Object.entries({x1:top.x,y1:top.y,x2:action.x,y2:action.y}))line.setAttribute(key,String(value));
    position(overlay.querySelector<HTMLElement>('[data-lasso-handle="rotate"]')!,action);
    position(overlay.querySelector<HTMLElement>('[data-lasso-action="copy"]')!,this.framePoint(frame,-46*v.width/r.width,-frame.height/2-38*v.height/r.height));
    position(overlay.querySelector<HTMLElement>('[data-lasso-action="delete"]')!,this.framePoint(frame,46*v.width/r.width,-frame.height/2-38*v.height/r.height));
    overlay.dataset.angle=String(frame.angle);
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
