import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { FileView, TFile } from "./mockObsidian";
import NoteInk from "../src/main";
import { StrokeStore } from "../src/ink/StrokeStore";
import { NativePdfAnnotationSession } from "../src/pdf/NativePdfAnnotationSession";
import { exportNativePdf } from "../src/pdf/exportNativePdf";
import { transformPoint, invertMatrix, type Matrix } from "../src/pdf/exportAnnotatedPdf";
import type { InkStroke } from "../src/ink/types";
const w=window as any;w.activeWindow=window;
for(const [key,get]of Object.entries({doc:function(this:Node){return this.ownerDocument||document;},win:function(this:Node){return (this.ownerDocument||document).defaultView;}}))Object.defineProperty(Node.prototype,key,{configurable:true,get});
Object.assign(HTMLElement.prototype,{setCssStyles(this:HTMLElement,styles:any){Object.assign(this.style,styles);},setCssProps(this:HTMLElement,props:any){for(const [k,v]of Object.entries(props))this.style.setProperty(k,String(v));},setAttr(this:HTMLElement,k:string,v:string){this.setAttribute(k,v);},hasClass(this:HTMLElement,c:string){return this.classList.contains(c);}});
const core=await import('/native/pdf.min.mjs' as string),ui=await import('/native/pdf.viewer.min.mjs' as string);core.GlobalWorkerOptions.workerSrc='/native/pdf.worker.min.mjs';
const files=new Map<string,Uint8Array>(),disk=new Map<string,string>();let failing=false;
const source='講義/標準ビューア.pdf';const file=new TFile(source);
const app:any={vault:{getAbstractFileByPath:(p:string)=>files.has(p)?p===source?file:new TFile(p):null,readBinary:async(f:TFile)=>files.get(f.path)!.slice().buffer,createBinary:async(p:string,b:ArrayBuffer)=>{if(files.has(p))throw new Error('exists');files.set(p,new Uint8Array(b));},adapter:{exists:async(p:string)=>disk.has(p)||files.has(p),mkdir:async()=>{},read:async(p:string)=>disk.get(p)!,write:async(p:string,raw:string)=>{if(failing&&p.endsWith('.ink.json'))throw new Error('disk full');disk.set(p,raw);}}},workspace:{activeLeaf:null,revealLeaf:()=>{},getActiveFile:()=>file,getActiveViewOfType:()=>null}};
const plugin:any=new NoteInk(app,{} as any);plugin.store=new StrokeStore(app,plugin);plugin.settings={openPdfWithAnnotationByDefault:false};
let leaf:any,view:any,session:NativePdfAnnotationSession,pdf:any,viewer:any,bus:any,legacyRaw:string;
async function fixture(count=50){
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
 for(let n=1;n<=count;n++){const p=doc.addPage(n%7===0?[500,380]:[420,320]);p.setCropBox(20,10,p.getWidth()-40,p.getHeight()-30);p.setRotation(degrees((n-1)%4*90));p.drawText(`Native PDF page ${n}`,{x:40,y:270,size:18,font});p.drawText('Original text remains selectable',{x:40,y:245,size:12,font});}
 return doc.save();
}
async function open(){
 files.set(source,await fixture());files.set('講義/別資料.pdf',await fixture(2));
 leaf={app,getViewState:()=>({type:'pdf',state:{file:source}}),setViewState:async()=>{},view:null};app.workspace.activeLeaf=leaf;
 view=new FileView(leaf);view.getViewType=()=>"pdf";view.onUnloadFile=async()=>{};view.onClose=async()=>{};view.file=file;leaf.view=view;
 view.contentEl.classList.add('pdf-container');view.contentEl.style.position='relative';
 const container=document.createElement('div');container.className='test-native-container';const body=document.createElement('div');body.className='pdfViewer';container.append(body);view.contentEl.append(container);
 bus=new ui.EventBus();const link=new ui.PDFLinkService({eventBus:bus});viewer=new ui.PDFViewer({container,viewer:body,eventBus:bus,linkService:link,l10n:new ui.IL10n(),removePageBorders:true,textLayerMode:1,annotationEditorMode:-1,abortSignal:new AbortController().signal});link.setViewer(viewer);
 bus.on('pagesinit',()=>{viewer.currentScaleValue='page-width';});pdf=await core.getDocument({data:files.get(source)!.slice(),useSystemFonts:true,isEvalSupported:false}).promise;link.setDocument(pdf);viewer.setDocument(pdf);
 view.viewer={then:(callback:any)=>callback({pdfViewer:{pdfViewer:viewer,eventBus:bus,pdfLoadingTask:{promise:Promise.resolve(pdf)}}})};
 const strokes:InkStroke[]=[];const width=760,height=580;
 for(let n=1;n<=50;n++){
  const p=await pdf.getPage(n),base=p.getViewport({scale:1}),scale=Math.min(width/base.width,height/base.height),v=p.getViewport({scale}),m=[...v.transform] as Matrix;m[4]+=(width-v.width)/2;m[5]+=(height-v.height)/2;
  for(let i=0;i<100;i++)strokes.push({id:`saved-${n}-${i}`,tool:i%5===0?'highlighter':'pen',color:'#e93b4a',width:(i%5===0?8:2)*scale,points:Array.from({length:20},(_,j)=>{const [x,y]=transformPoint(m,55+j*3,40+(i%20)*10+Math.sin(j/3)*3);return {x,y:y+(n-1)*592,t:j*8,pressure:.7};})});
 }
 legacyRaw=JSON.stringify({version:1,sourcePath:source,sourceMtime:1,pageWidth:width,pageHeight:50*580+49*12,strokes,pdfTextAnnotations:[{id:'old-note',pageNumber:1,kind:'note',color:'#8b5cf6',text:'Original',note:'旧注釈のコメント',pageWidth:width,pageHeight:height,rects:[{x:100,y:300,width:100,height:20}],createdAt:1}],updatedAt:1});
 disk.set(plugin.store.getAnnotationPath(source),legacyRaw);
 const start=performance.now();await plugin.openInkForFile(file,leaf);session=plugin.pdfSessions.get(leaf);if(!session)throw new Error('native session did not open');
 return {openMs:performance.now()-start,version:session.controller.annotation.version,strokes:session.controller.annotation.strokes.length,legacyUntouched:disk.get(plugin.store.getAnnotationPath(source))===legacyRaw};
}
function point(n:number,x:number,y:number){const p=viewer.getPageView(n-1),r=p.canvas.getBoundingClientRect(),[px,py]=transformPoint(p.viewport.transform,x,y);return {x:r.left+px*r.width/p.viewport.width,y:r.top+py*r.height/p.viewport.height};}
function pen(n=1,x=140,y=160){const p=point(n,x,y),target=document.elementFromPoint(p.x,p.y)!;
 const send=(type:string,dx=0)=>target.dispatchEvent(new PointerEvent(type,{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:7,button:0,buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.7,clientX:p.x+dx,clientY:p.y}));
 send('pointerdown');send('pointermove',45);send('pointerup',60);
}
function finger(){const p=point(1,140,160),target=document.elementFromPoint(p.x,p.y)!;const e=new PointerEvent('pointerdown',{view:window,bubbles:true,cancelable:true,pointerType:'touch',pointerId:8,button:0,buttons:1,width:24,height:24,pressure:.5,clientX:p.x,clientY:p.y});target.dispatchEvent(e);return {prevented:e.defaultPrevented,pan:(session.controller as any).input?.engine.panPointerId??null,penClass:viewer.getPageView(0).div.classList.contains('note-ink-pen-contact')};}
function snapshot(){const canvases=[...view.contentEl.querySelectorAll('.note-ink-native-overlay canvas,.note-ink-native-live,.note-ink-native-committed')] as HTMLCanvasElement[];
 return {page:viewer.currentPageNumber,strokes:session.controller.annotation.strokes.length,live:view.contentEl.querySelectorAll('.note-ink-native-live').length,display:view.contentEl.querySelectorAll('.note-ink-native-overlay').length,pixels:canvases.reduce((n,c)=>n+c.width*c.height,0),diagnostics:{...session.controller.diagnostics},cached:[...viewer.getCachedPageViews()].map((p:any)=>p.id)};}
async function saveReload(){await session.save();const raw=disk.get(plugin.store.getAnnotationPath(source))!,a=JSON.parse(raw);await session.close();await plugin.openInkForFile(file,leaf);session=plugin.pdfSessions.get(leaf);return {version:a.version,count:a.strokes.length,reloaded:session.controller.annotation.strokes.length,hasGlobalHeight:'pageHeight'in a,backups:[...disk].filter(([p])=>p.endsWith('.bak')).map(([,s])=>s===legacyRaw)};}
async function saveFailure(){failing=true;session.controller.replaceStrokes([...session.controller.getStrokes(),{id:'save-failure',tool:'pen',color:'#e93b4a',width:2,pageNumber:1,points:[{x:100,y:100,t:1,pressure:.7}]}]);let rejected=false;try{await session.close();}catch{rejected=true;}const retained=!session.closed,errorVisible=!!view.contentEl.querySelector('[role=alert]');failing=false;await session.save();return {rejected,retained,errorVisible,cleared:!view.contentEl.querySelector('[role=alert]')};}
async function exportCheck(){const bytes=await exportNativePdf(pdf,session.controller.annotation,()=>{}),copy=await core.getDocument({data:bytes.slice(),isEvalSupported:false}).promise;const checks:any[]=[];
 for(const n of [1,2,7,20]){const p=await copy.getPage(n),v=p.getViewport({scale:1}),c=document.createElement('canvas');c.width=Math.ceil(v.width);c.height=Math.ceil(v.height);await p.render({canvasContext:c.getContext('2d'),canvas:c,viewport:v}).promise;const pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>160&&pixels[i+1]<130&&pixels[i+2]<150)red++;checks.push({page:n,red,text:(await p.getTextContent()).items.map((x:any)=>x.str).join(' '),notes:(await p.getAnnotations()).map((a:any)=>a.contentsObj?.str)});}
 await copy.destroy();return {bytes:Array.from(bytes),checks};}
async function switchFile(){pen(1,170,150);const count=session.controller.annotation.strokes.length;await view.onUnloadFile(file);view.file=new TFile('講義/別資料.pdf');return {closed:session.closed,saved:JSON.parse(disk.get(plugin.store.getAnnotationPath(source))!).strokes.length,count,live:view.contentEl.querySelectorAll('.note-ink-native-live').length,tools:view.contentEl.querySelectorAll('.note-ink-native-tools').length};}
function textSelection(){document.querySelector<HTMLButtonElement>('button[aria-label="閲覧・文字選択"]')!.click();const span=viewer.getPageView(0).div.querySelector('.textLayer span')!,range=document.createRange();range.selectNodeContents(span);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);const box=span.getBoundingClientRect();viewer.container.dispatchEvent(new MouseEvent('contextmenu',{view:window,bubbles:true,cancelable:true,clientX:box.x+10,clientY:box.y+10}));return {text:document.getSelection()!.toString(),menu:document.querySelector('.test-menu')?.textContent};}
w.nativeHarness={open,pen,point,finger,snapshot,saveReload,saveFailure,exportCheck,switchFile,textSelection,get session(){return session;},get viewer(){return viewer;},get view(){return view;},get pdf(){return pdf;},get plugin(){return plugin;},get disk(){return disk;}};
w.nativeReady=true;

w.nativeHarness.cutoutExport=async()=>{
 const bytes=await exportNativePdf(pdf,session.controller.annotation,()=>{}),copy=await core.getDocument({data:bytes.slice(),isEvalSupported:false}).promise;
 const p=await copy.getPage(1),v=p.getViewport({scale:2}),c=document.createElement('canvas');c.width=Math.ceil(v.width);c.height=Math.ceil(v.height);
 await p.render({canvas:c,canvasContext:c.getContext('2d'),viewport:v}).promise;
 const samples=[100,170,240].map(x=>{const [px,py]=transformPoint(v.transform,x,150);return Array.from(c.getContext('2d')!.getImageData(Math.round(px),Math.round(py),1,1).data);});await copy.destroy();return samples;
};
