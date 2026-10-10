import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import {PageInkController} from '../src/ink/PageInkController';
import MobileInkPlugin from '../src/main';
import {drawStroke,drawStrokeSegment,drawStrokeTail,strokeWidths} from '../src/ink/renderer';
import {AnnotationView} from '../src/views/AnnotationView';
import {StrokeStore} from '../src/ink/StrokeStore';
import {TFile} from './mockObsidian';
import {exportAnnotatedPdf, type ExportPage} from '../src/pdf/exportAnnotatedPdf';
import {loadPdfJs} from './mockObsidian';

async function fixture(count=4) {
 const doc=await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);
 for(let i=0;i<count;i++) {
  const page=doc.addPage([420,320]);page.setCropBox(20,10,380,290);page.setRotation(degrees((i%4)*90));
  page.drawText(`Lecture slide ${i+1}`,{x:35,y:270,size:18,font});
  page.drawText('Original text remains selectable',{x:35,y:245,size:12,font});
  page.drawRectangle({x:40,y:60,width:80,height:80,color:rgb(.9,.92,.96)});
 }
 return doc.save();
}
const sourcePath='講義/第1回.pdf';
const files=new Map<string,Uint8Array>();const sidecars=new Map<string,string>();
const file=new TFile(sourcePath);
const vault:any={getAbstractFileByPath:(path:string)=>files.has(path)?(path===sourcePath?file:new TFile(path)):null,
 readBinary:async(f:TFile)=>files.get(f.path)!.slice().buffer,
 createBinary:async(path:string,data:ArrayBuffer)=>{if(files.has(path))throw new Error('exists');files.set(path,new Uint8Array(data));},
 adapter:{exists:async(path:string)=>files.has(path)||sidecars.has(path),mkdir:async()=>{},read:async(path:string)=>sidecars.get(path)!,write:async(path:string,data:string)=>sidecars.set(path,data),getResourcePath:(path:string)=>`/missing/${path}`},
};
let failWrites=false,detachCalls=0;const originalWrite=vault.adapter.write;
vault.adapter.write=async(path:string,data:string)=>{if(failWrites)throw new Error('disk full');return originalWrite(path,data);};
const app:any={vault,workspace:{getActiveViewOfType:()=>view,getActiveFile:()=>file,detachLeavesOfType:()=>{detachCalls++;},revealLeaf:()=>{}}};
const plugin:any=new MobileInkPlugin(app,{} as any);plugin.store=new StrokeStore(app,plugin);plugin.settings={openPdfWithAnnotationByDefault:false};
let view:any,leaf:any;

async function open(count=4){
 if(view){await view.onClose();view.containerEl.remove();}
 files.set(sourcePath,await fixture(count));
 let state:any={type:'lecture-ink-annotation-view',state:{file:sourcePath}};
 leaf={app,getViewState:()=>state,setViewState:async(next:any)=>{state=next;},view:null};app.workspace.activeLeaf=leaf;
 view=new AnnotationView(leaf,plugin);leaf.view=view;
 await view.setState({file:sourcePath},{});await view.onOpen();
}
async function addTestInk(){
 const entries=view.pdfBackgroundPages;
 const strokes=entries.map((entry:any,i:number)=>({id:`test-${i}`,tool:'pen',color:'#fa343f',width:6,points:[{x:entry.viewport.width/2-30,y:entry.offsetY+entry.viewport.height/2,t:0,pressure:.8},{x:entry.viewport.width/2+30,y:entry.offsetY+entry.viewport.height/2+30,t:20,pressure:.8}]}));
 view.engine.loadStrokes(strokes);view.saveQueue.markDirty();
 view.pdfTextAnnotations=[{id:'japanese-note',kind:'note',pageNumber:1,pageWidth:entries[0].viewport.width,pageHeight:entries[0].viewport.height,color:'#8b5cf6',text:'Lecture',note:'ここは試験に出る',rects:[{x:170,y:100,width:80,height:20}],createdAt:1}];
}
async function verifyExport(path:string){
 const pdfjs=await loadPdfJs();const bytes=files.get(path)!;
 const doc=await pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false}).promise;
 const visuals: Array<{page:number;red:number;text:string;notes:unknown[]}> = [];
 for(let i=1;i<=doc.numPages;i++){
  const page=await doc.getPage(i),viewport=page.getViewport({scale:1});
  const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;canvas.style.width='380px';canvas.style.margin='10px';canvas.style.border='1px solid #ddd';
  await page.render({canvasContext:canvas.getContext('2d')!,viewport}).promise;
  document.querySelector('#exports')!.append(canvas);
  const ctx=canvas.getContext('2d')!;const image=ctx.getImageData(0,0,canvas.width,canvas.height);let red=0;
  for(let j=0;j<image.data.length;j+=4)if(image.data[j]>180&&image.data[j+1]<130&&image.data[j+2]<150)red++;
  visuals.push({page:i,red,text:(await page.getTextContent()).items.map((x:any)=>x.str).join(' '),notes:(await page.getAnnotations()).map((x:any)=>x.contentsObj?.str)});
 }
 await doc.destroy();return{bytes:bytes.length,visuals};
}
async function rejectedSidecar(){
 const evilPath='講義/悪意ある注釈.md';files.set(evilPath,new Uint8Array());
 const sidecarPath=(plugin.store as any).getAnnotationPath(evilPath);
 const raw=JSON.stringify({pageWidth:960,pageHeight:1e12,strokes:[{id:'one',tool:'pen',color:'#000000',width:2,points:[{x:1,y:1,t:1,pressure:1}]}]});
 sidecars.set(sidecarPath,raw);
 const rejected:any=new AnnotationView({app} as any,plugin);await rejected.setState({file:evilPath},{});await rejected.onOpen();
 const result={engine:rejected.engine===null,tiles:rejected.containerEl.querySelectorAll('.mobile-ink-tile').length,message:rejected.contentEl.textContent,preserved:sidecars.get(sidecarPath)===raw};
 rejected.containerEl.remove();
 sidecars.set(sidecarPath,'{corrupt');
 const broken:any=new AnnotationView({app} as any,plugin);await broken.setState({file:evilPath},{});await broken.onOpen();
 const corruptPreserved=sidecars.get(sidecarPath)==='{corrupt'&&broken.engine===null;broken.containerEl.remove();
 return{...result,corruptPreserved};
}
async function performanceFixture() {
 const opening=performance.now();await open(50);const openMs=performance.now()-opening;
 const strokes=view.pdfBackgroundPages.flatMap((entry:any)=>Array.from({length:100},(_,i)=>({id:`large-${entry.pageNumber}-${i}`,tool:'pen',color:'#111111',width:2,points:Array.from({length:20},(_,j)=>({x:40+j*3,y:entry.offsetY+40+(i%20)*15+Math.sin(j/3)*4,t:j*8,pressure:.7}))})));
 const loading=performance.now();view.engine.loadStrokes(strokes);const loadMs=performance.now()-loading;
 await new Promise(r=>setTimeout(r,1000));
 view.saveQueue.debounceMs=10000;
 const controller=view.engine;
 let globalUpdates=0, pageUpdates=0;
 const apply=controller.applyGlobalStrokes.bind(controller);
 controller.applyGlobalStrokes=(...args:any[])=>{globalUpdates++;return apply(...args);};
 const page=controller.pages.find((p:any)=>p.engine);
 for(const p of controller.pages){if(!p.engine)continue;const replace=p.engine.replaceStrokes.bind(p.engine);p.engine.replaceStrokes=(...args:any[])=>{pageUpdates++;return replace(...args);};}
 const rect=page.liveCanvas.getBoundingClientRect();
 const send=(type:string,x:number,y:number,t:number)=>page.liveCanvas.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'pen',pointerId:7,isPrimary:true,buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.7,clientX:rect.left+x,clientY:rect.top+y}));
 send('pointerdown',80,80,0);
 const start=performance.now();for(let i=0;i<1000;i++)send('pointermove',80+(i%200),80+Math.sin(i/20)*30,i*8);const moveMs=performance.now()-start;
 const up=performance.now();send('pointerup',280,80,8000);const upMs=performance.now()-up;
 await new Promise(r=>setTimeout(r,400));
 const canvases=controller.pages.flatMap((p:any)=>[p.liveCanvas,p.committedCanvas]).filter(Boolean);
 const pixels=canvases.reduce((n:number,c:any)=>n+c.width*c.height,0);
 const zoomStart=performance.now();view.setZoom(2);await frame();await frame();const zoomMs=performance.now()-zoomStart;
 const zoomCanvases=controller.pages.flatMap((p:any)=>[p.liveCanvas,p.committedCanvas]).filter(Boolean);
 const zoomPixels=zoomCanvases.reduce((n:number,c:any)=>n+c.width*c.height,0);
 const maxLayerPixels=Math.max(...zoomCanvases.map((c:any)=>c.width*c.height));
 const zoom4Pixels=(window as any).baseline ? null : await (async()=>{view.setZoom(4);await frame();await frame();return controller.pages.flatMap((p:any)=>[p.liveCanvas,p.committedCanvas]).filter(Boolean).reduce((n:number,c:any)=>n+c.width*c.height,0);})();
 const moveStart=performance.now();view.goToPdfPage(30);await new Promise(r=>setTimeout(r,750));const navigationMs=performance.now()-moveStart;
 const near=controller.pages.filter((p:any)=>p.engine).map((p:any)=>p.pageNumber);
 return {pages:50,strokes:5000,openMs,loadMs,moveMs,upMs,globalUpdates,pageUpdates,pixels,canvases:canvases.length,zoomMs,zoomPixels,zoom4Pixels,maxLayerPixels,navigationMs,near};
}
function paintEvent(page:any,type:string,x:number,y:number,id=42):void {
 const rect=page.liveCanvas.getBoundingClientRect();
 const event=new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'pen',pointerId:id,isPrimary:true,buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.7,clientX:rect.left+x,clientY:rect.top+y});
 page.liveCanvas.dispatchEvent(event);
}
async function frame(){await new Promise(r=>requestAnimationFrame(r));}
function inkPage(){return view.engine.pages.find((p:any)=>p.engine);}
function sampleInk(){return Array.from({length:150},(_,i)=>({x:45+i*1.4,y:120+Math.sin(i/12)*32,t:i*8,pressure:.45+.2*Math.sin(i/10)}));}
async function interactionChecks(){
 await open();await new Promise(r=>setTimeout(r,500));
 const controller=view.engine,p=inkPage();
 const draw=async(tool='pen')=>{controller.setToolState({tool});const samples=sampleInk();paintEvent(p,'pointerdown',samples[0].x,samples[0].y);for(let i=1;i<samples.length;i++){paintEvent(p,'pointermove',samples[i].x,samples[i].y);if(i%25===0)await frame();}paintEvent(p,'pointerup',samples[149].x,samples[149].y);await frame();};
 await draw();await draw();
 const two=controller.getStrokes().length;
 controller.undo();const one=controller.getStrokes().length;controller.undo();const zero=controller.getStrokes().length;controller.redo();controller.redo();
 const restored=controller.getStrokes().length;
 const savedStroke=controller.getStrokes()[0], engine=p.engine;
 // Compare the actual streamed pen canvas against a full redraw of the exact same strokes.
 const streamed=engine.committedCtx.getImageData(0,0,p.committedCanvas.width,p.committedCanvas.height).data;
 engine.renderCommittedNow();const redrawn=engine.committedCtx.getImageData(0,0,p.committedCanvas.width,p.committedCanvas.height).data;
 let penDifference=0;for(let i=0;i<streamed.length;i++)if(streamed[i]!==redrawn[i])penDifference++;
 // A complete eraser gesture removes both intersecting lines and produces one undo entry.
 controller.setToolState({tool:'eraser'});paintEvent(p,'pointerdown',90,140);paintEvent(p,'pointermove',150,95);paintEvent(p,'pointerup',150,95);await frame();
 const erased=controller.getStrokes().length;controller.undo();const eraseUndo=controller.getStrokes().length;
 controller.clear();controller.setToolState({tool:'pen'});
 paintEvent(p,'pointerdown',60,210);
 const rect=p.liveCanvas.getBoundingClientRect();p.liveCanvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',pointerId:55,buttons:1,pressure:.5,width:40,height:40,clientX:rect.left+90,clientY:rect.top+220}));
 paintEvent(p,'pointerup',60,210);const dotPoints=controller.getStrokes()[0].points.length;const palmStrokes=controller.getStrokes().length;
 controller.clear();paintEvent(p,'pointerdown',60,215);paintEvent(p,'pointermove',100,215);paintEvent(p,'pointercancel',100,215);await new Promise(r=>setTimeout(r,450));
 const cancelled=controller.getStrokes().length;controller.undo();const cancelledUndo=controller.getStrokes().length;
 controller.clear();await draw('highlighter');const highlighted=controller.getStrokes()[0];
 const pixels=engine.committedCtx.getImageData(0,0,p.committedCanvas.width,p.committedCanvas.height).data;
 let maxAlpha=0;for(let i=3;i<pixels.length;i+=4)maxAlpha=Math.max(maxAlpha,pixels[i]);
 const oldColor='#1473aa';controller.setToolState({tool:'highlighter',highlighterColor:oldColor,highlighterWidth:19});view.activateEraser();view.activateEraser();
 const toggle=controller.getToolState();view.setTool('highlighter');const browse=view.browseMode;
 // Save must wait while a Pencil stroke is in progress, including more than the debounce interval.
 await view.flushCurrentWork();let writes=0;const write=vault.adapter.write;vault.adapter.write=async(...args:any[])=>{writes++;return write(...args);};
 paintEvent(p,'pointerdown',60,200);await new Promise(r=>setTimeout(r,850));const during= writes;
 paintEvent(p,'pointermove',160,200);paintEvent(p,'pointerup',160,200);await new Promise(r=>setTimeout(r,950));const after=writes;
 vault.adapter.write=write;
 // Error recovery preserves the leaf, dirty ink, and retry control.
 controller.clear();await draw();failWrites=true;
 let rejected=false;try{await view.exitAnnotationView();}catch{rejected=true;}
 const retained=leaf.getViewState().type==='lecture-ink-annotation-view' && controller.getStrokes().length===1;
 const retryVisible=!!view.contentEl.querySelector('.note-ink-save-error button');
 failWrites=false;await view.flushCurrentWork();const errorCleared=!view.contentEl.querySelector('.note-ink-save-error');
 const sibling={type:'pdf',state:{file:'other.pdf'}};
 plugin.settings.openPdfWithAnnotationByDefault=true;
 paintEvent(p,'pointerdown',80,230);paintEvent(p,'pointermove',180,230);
 await view.exitAnnotationView();
 const finalSaved=JSON.parse(sidecars.get(plugin.store.getAnnotationPath(sourcePath))!).strokes.length;
 for(let i=0;i<3;i++)await plugin.openPdfWithAnnotationByDefaultIfNeeded(file);
 const source=leaf.getViewState();
 return {two,one,zero,restored,dotPoints,palmStrokes,cancelled,cancelledUndo,penDifference,erased,eraseUndo,maxAlpha,toggle,browse,during,after,rejected,retained,retryVisible,errorCleared,source,finalSaved,detachCalls,sibling,savedPoints:savedStroke.points.length,highlighterPoints:highlighted.points.length};
}
async function renderingChecks(){
 const results:Array<{tool:string;stable:boolean;maxDifference:number}>=[];
 for(const tool of ['pen','highlighter']) {
  const stroke:any={id:tool,tool,color:'#345678',width:tool==='pen'?5:18,points:sampleInk()};
  const full=document.createElement('canvas');full.width=400;full.height=250;drawStroke(full.getContext('2d')!,stroke);
  const incremental=document.createElement('canvas');incremental.width=400;incremental.height=250;
  const ctx=incremental.getContext('2d')!;const partial:any={...stroke,points:[]};
  let stable=true,previous:number[]=[];
  for(let i=0;i<stroke.points.length;i++) {partial.points.push(stroke.points[i]);const widths=[...strokeWidths(partial)];if(previous.some((w,j)=>w!==widths[j]))stable=false;previous=widths;drawStrokeSegment(ctx,partial,i,tool==='highlighter');}
  drawStrokeTail(ctx,partial,tool==='highlighter');
  if(tool==='highlighter') {const final=document.createElement('canvas');final.width=400;final.height=250;const f=final.getContext('2d')!;f.globalAlpha=.35;f.drawImage(incremental,0,0);results.push({tool,stable,maxDifference:compare(full,final)});}
  else results.push({tool,stable,maxDifference:compare(full,incremental)});
 }
 return results;
}
function compare(a:HTMLCanvasElement,b:HTMLCanvasElement):number {const x=a.getContext('2d')!.getImageData(0,0,a.width,a.height).data,y=b.getContext('2d')!.getImageData(0,0,b.width,b.height).data;let max=0;for(let i=0;i<x.length;i+=4)max=Math.max(max,Math.abs(x[i+3]-y[i+3]));return max;}
async function boundaryChecks(){
 const root=document.createElement('div');root.className='mobile-ink-root';root.style.cssText='position:fixed;left:0;top:0;width:400px;height:700px;z-index:1000';document.body.append(root);
 const scroll=document.createElement('div');scroll.style.cssText='position:relative;height:700px;overflow:auto';root.append(scroll);
 const descriptors=[0,200,440].map((offsetY,i)=>{const pageEl=document.createElement('div');pageEl.style.cssText=`position:absolute;top:${offsetY}px;width:400px;height:240px`;scroll.append(pageEl);return {pageNumber:i+1,pageEl,width:400,height:240,offsetY,inputTop:i===0?0:20,inputBottom:220};});
 const controller:any=new PageInkController(descriptors,{scrollEl:scroll,onChange:()=>{}});
 await frame();await frame();
 const [a,b,c]=controller.pages;let untouched=0;const replace=c.engine.replaceStrokes.bind(c.engine);c.engine.replaceStrokes=(...args:any[])=>{untouched++;return replace(...args);};
 paintEvent(a,'pointerdown',100,190);paintEvent(a,'pointermove',130,220);await frame();paintEvent(a,'pointermove',150,270);paintEvent(a,'pointerup',150,270);await frame();
 const drawn=controller.getStrokes().length,replicas=[a.engine.getStrokeRefs().length,b.engine.getStrokeRefs().length];
 controller.undo();const undone=controller.getStrokes().length;controller.redo();const redone=controller.getStrokes().length;
 controller.setToolState({tool:'eraser'});paintEvent(b,'pointerdown',150,70);paintEvent(b,'pointerup',150,70);await frame();const erased=controller.getStrokes().length;controller.undo();
 const restored=controller.getStrokes().length;
 const stroke=controller.getStrokes()[0];controller.loadStrokes([stroke]);const reloaded=controller.getStrokes().length;
 controller.destroy();root.remove();return {drawn,replicas,undone,redone,erased,restored,reloaded,untouched};
}
async function pinchChecks(){
 await open();await new Promise(r=>setTimeout(r,200));view.saveQueue.markDirty();
 const target=view.scrollEl;
 const touch=(id:number,x:number)=>({identifier:id,target,clientX:x,clientY:240,pageX:x,pageY:240,screenX:x,screenY:240}) as Touch;
 const send=(type:string,ts:Touch[])=>{const event=new Event(type,{bubbles:true,cancelable:true});const list=Object.assign(ts,{item:(i:number)=>ts[i]});for(const key of ['touches','targetTouches','changedTouches'])Object.defineProperty(event,key,{value:list});target.dispatchEvent(event);};
 send('touchstart',[touch(1,150),touch(2,250)]);send('touchmove',[touch(1,100),touch(2,300)]);
 const active=!!view.pinchZoomState;send('touchend',[]);await frame();await new Promise(r=>setTimeout(r,950));
 return {active,ended:view.pinchZoomState===null,zoom:view.zoom,saved:sidecars.has(plugin.store.getAnnotationPath(sourcePath)),paused:view.saveQueue.paused};
}
(window as any).harness={boundaryChecks,pinchChecks,interactionChecks,renderingChecks,performanceFixture,rejectedSidecar,open,addTestInk,verifyExport,files,sidecars,get view(){return view;},fixture,exportAnnotatedPdf,loadPdfJs};
