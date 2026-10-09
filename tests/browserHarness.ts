import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
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
const app:any={vault,workspace:{getActiveFile:()=>file,detachLeavesOfType:()=>{}}};
const plugin:any={manifest:{id:'obsidian-lecture-ink'},hasFeature:()=>true};plugin.store=new StrokeStore(app,plugin);
let view:any;
async function open(){files.set(sourcePath,await fixture());view=new AnnotationView({app} as any,plugin);await view.setState({file:sourcePath},{});await view.onOpen();}
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
(window as any).harness={rejectedSidecar,open,addTestInk,verifyExport,files,sidecars,get view(){return view;},fixture,exportAnnotatedPdf,loadPdfJs};
