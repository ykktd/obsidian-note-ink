import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveExportCopy} from '../src/pdf/saveExportCopy';
import {overlayMatrix,transformPoint,invertMatrix,type ExportPage} from '../src/pdf/exportAnnotatedPdf';
import {SaveQueue} from '../src/ink/SaveQueue';

globalThis.window=globalThis as unknown as Window & typeof globalThis;

test('overlay position follows rotation, cropped origin and letterboxing',()=>{
  for (const m of [[2,0,0,-2,-20,640],[0,2,2,0,-40,-20],[-2,0,0,2,680,-40],[0,-2,-2,0,640,680]]) {
    const page: ExportPage={pageNumber:1,width:700,height:660,offsetY:0,transform:m as ExportPage['transform']};
    const image=overlayMatrix(page);
    for (const [u,v] of [[0,0],[1,1],[0.3,0.8]]) {
      const pdf=transformPoint(image,u,v);
      const display=transformPoint(page.transform,...pdf);
      assert.ok(Math.abs(display[0]-u*page.width)<1e-6);
      assert.ok(Math.abs(display[1]-(1-v)*page.height)<1e-6);
    }
  }
  assert.throws(()=>invertMatrix([0,0,0,0,0,0]));
});

test('export creates a distinct Japanese filename, respects adapter-only files and races',async()=>{
  const files=new Map<string,ArrayBuffer>();
  const source='講義/第1回.pdf'; files.set(source,new Uint8Array([1,2]).buffer);
  files.set('講義/第1回-書き込み.pdf',new Uint8Array([9]).buffer);
  let raced=false;
  const vault={getAbstractFileByPath:()=>null,adapter:{exists:async(path:string)=>files.has(path)},createBinary:async(path:string,data:ArrayBuffer)=>{
    if (!raced) {raced=true;files.set(path,new Uint8Array([8]).buffer);throw new Error('sync race');}
    assert.ok(!files.has(path));files.set(path,data);
  }};
  assert.equal(await saveExportCopy(vault,source,new Uint8Array([3,4])),'講義/第1回-書き込み-3.pdf');
  assert.deepEqual([...new Uint8Array(files.get(source)!)],[1,2]);
  assert.deepEqual([...new Uint8Array(files.get('講義/第1回-書き込み-2.pdf')!)],[8]);
  for (const path of ['../lecture.pdf','/lecture.pdf','講義/../lecture.pdf']) await assert.rejects(saveExportCopy(vault,path,new Uint8Array()));
});

test('export does not overwrite on permission failure',async()=>{
  const vault={getAbstractFileByPath:()=>null,adapter:{exists:async()=>false},createBinary:async()=>{throw new Error('permission');}};
  await assert.rejects(saveExportCopy(vault,'slide.pdf',new Uint8Array([1])),/permission/);
});

test('manual flush waits for autosave and flushes edits made during the save',async()=>{
  let release!: ()=>void;let calls=0;
  const gate=new Promise<void>(r=>release=r);
  const queue=new SaveQueue(async()=>{calls++;if(calls===1)await gate;},10000);
  queue.markDirty();const first=queue.flush();queue.markDirty();
  let finished=false;const second=queue.flush().then(()=>finished=true);
  await Promise.resolve();assert.equal(finished,false);release();await Promise.all([first,second]);assert.equal(calls,2);
});

test('save failures retain dirty ink and are reported, then can be retried',async()=>{
  let failing=true,reported=0,saves=0;
  const queue=new SaveQueue(async()=>{if(failing)throw new Error('full');saves++;},10000,()=>reported++);
  queue.markDirty();await assert.rejects(queue.flush(),/full/);assert.equal(reported,1);
  failing=false;await queue.flush();assert.equal(saves,1);
});

import {assertDimensions,MAX_PDF_PAGE_HEIGHT} from '../src/utils/resourceLimits';
test('reject malicious sidecar geometry before proportional DOM allocation',()=>{
  for(const height of [1e12,Infinity,NaN,-1,160001]) assert.throws(()=>assertDimensions(960,height));
  assert.throws(()=>assertDimensions(1e12,480));
  assert.throws(()=>assertDimensions(960,16001,MAX_PDF_PAGE_HEIGHT));
  assert.doesNotThrow(()=>assertDimensions(960,160000));
});

import {StrokeHistory,strokeChange,applyStrokeChange} from '../src/ink/StrokeHistory';
import type {InkStroke} from '../src/ink/types';
const line=(id:string,x=0):InkStroke=>({id,tool:'pen',color:'#111111',width:2,points:[{x,y:10,t:1,pressure:.7}]});
test('history keeps only changed strokes and restores deletion order',()=>{
  const before=Array.from({length:5000},(_,i)=>line(String(i))),added=line('new');
  const change=strokeChange(before,[...before,added]);
  assert.equal(change.removed.length,0);assert.equal(change.added.length,1);assert.equal(change.added[0].stroke,added);
  const h=new StrokeHistory();h.record(change);assert.ok(h.canUndo&&!h.canRedo);
  const without=before.filter((_,i)=>i!==2&&i!==4000),erase=strokeChange(before,without);
  assert.equal(erase.removed.length,2);assert.equal(erase.added.length,0);
  assert.deepEqual(applyStrokeChange(without,erase,false),before);
  assert.deepEqual(applyStrokeChange(before,erase),without);
  const undone=h.undo()!;assert.equal(applyStrokeChange([...before,added],undone,false).length,5000);assert.ok(!h.canUndo&&h.canRedo);
  h.record(strokeChange(before,[...before,line('other')]));assert.equal(h.canRedo,false);
});
test('history supports changed geometry, reordering, and bounded depth',()=>{
  const a=line('a'),b=line('b'),changed=line('a',20);
  const edit=strokeChange([a,b],[changed,b]);assert.equal(edit.added.length,1);assert.equal(edit.removed.length,1);
  assert.deepEqual(applyStrokeChange([changed,b],edit,false),[a,b]);
  const reordered=strokeChange([a,b],[b,a]);assert.deepEqual(applyStrokeChange([a,b],reordered),[b,a]);
  const h=new StrokeHistory();for(let i=0;i<50;i++)h.record({removed:[],added:[{index:i,stroke:line(String(i))}]});
  let count=0;while(h.undo())count++;assert.equal(count,40);
});
test('autosave pauses during input, resumes, and explicit flush includes pending edits',async()=>{
  let calls=0;const q=new SaveQueue(async()=>{calls++;},5);
  q.markDirty();q.setPaused(true);await new Promise(r=>setTimeout(r,15));assert.equal(calls,0);
  q.setPaused(false);await new Promise(r=>setTimeout(r,15));assert.equal(calls,1);
  q.setPaused(true);q.markDirty();await q.flush();assert.equal(calls,2);
});
test('a paused autosave does not start another write after an in-flight save',async()=>{
  let release!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r);
  const q=new SaveQueue(async()=>{calls++;if(calls===1)await gate;},10000);
  q.markDirty();const saving=q.flush(false);await Promise.resolve();q.setPaused(true);q.markDirty();release();await saving;
  assert.equal(calls,1);await q.flush();assert.equal(calls,2);
});

import {migratePdfAnnotation,toPdfStroke,toViewportStroke,validatePdfAnnotation,pdfMarkShapes,type PdfDocument,type PdfViewport} from '../src/pdf/pdfCoordinates';
import {StrokeStore} from '../src/ink/StrokeStore';
import type {AnnotationFile,PdfAnnotationFile} from '../src/ink/types';
import {TFile} from './nodeObsidian';
function pageModel(rotation=0){return {getViewport:({scale,rotation:override=rotation}: {scale:number;rotation?:number}):PdfViewport=>{
  const table:Record<number,Matrix>={0:[1,0,0,-1,-20,300],90:[0,1,1,0,-10,-20],180:[-1,0,0,1,400,-10],270:[0,-1,-1,0,300,400]};
  return {width:(override%180===0?380:290)*scale,height:(override%180===0?290:380)*scale,scale,rotation:override,transform:table[override].map(x=>x*scale) as Matrix};
}};}
import type {Matrix} from '../src/pdf/exportAnnotatedPdf';
const legacy=(strokes:InkStroke[],height=580):AnnotationFile=>({version:1,sourcePath:'test.pdf',sourceMtime:1,pageWidth:760,pageHeight:height,strokes,pdfTextAnnotations:[],updatedAt:1});
test('v1 migration preserves crop/rotation, pressure and timing; subsequent saves use only v2',async()=>{
  const pdf:PdfDocument={numPages:2,getPage:async n=>pageModel(n===1?0:90),getData:async()=>new Uint8Array()};
  const layouts=[{matrix:[2,0,0,-2,-40,600] as Matrix,offset:0},{matrix:[0,580/380,580/380,0,(-10*580/380)+(760-290*580/380)/2,-20*580/380] as Matrix,offset:592}];
  const input=layouts.map((layout,i)=>({id:String(i),tool:'pen' as const,color:'#112233',width:3,points:[{x:0,y:0,t:17,pressure:.61}].map(p=>{const [x,y]=transformPoint(layout.matrix,140,130);return {...p,x,y:y+layout.offset};})}));
  const migrated=await migratePdfAnnotation(legacy(input,1172),pdf);
  for(const [i,s]of migrated.strokes.entries()){assert.equal(s.pageNumber,i+1);assert.ok(Math.abs(s.points[0].x-140)<1e-8);assert.ok(Math.abs(s.points[0].y-130)<1e-8);assert.equal(s.points[0].pressure,.61);assert.equal(s.points[0].t,17);}
  assert.equal(migrated.version,2);assert.equal('pageHeight' in migrated,false);
});
test('v1 single-page minimum height and boundary-crossing ink do not shift or vanish',async()=>{
  const single:PdfDocument={numPages:1,getPage:async()=>pageModel(),getData:async()=>new Uint8Array()};
  const a=legacy([{...line('one'),points:[{x:120,y:170,t:1,pressure:1}]}],480);a.pageWidth=380;
  const converted=await migratePdfAnnotation(a,single);assert.equal(converted.strokes[0].points[0].x,140);assert.equal(converted.strokes[0].points[0].y,130);
  const pdf={...single,numPages:2};const cross=legacy([{...line('cross'),points:[{x:120,y:285,t:1,pressure:.8},{x:130,y:405,t:2,pressure:.9}]}],592);cross.pageWidth=380;
  const both=await migratePdfAnnotation(cross,pdf);assert.deepEqual(both.strokes.map(s=>s.pageNumber),[1,2]);assert.equal(both.strokes[0].points.length,2);assert.equal(both.strokes[1].points.length,2);assert.notEqual(both.strokes[0].id,both.strokes[1].id);
});
test('drawing coordinates survive arbitrary zoom and right-angle display rotations',()=>{
  for(const rotation of [0,90,180,270])for(const scale of [.7,1,3.2]){
    const viewport=pageModel(rotation).getViewport({scale});const original={...line('roundtrip'),points:[{x:123.4,y:152.8,t:9,pressure:.72}]};
    const local=toViewportStroke(original,viewport),converted=toPdfStroke(local,1,viewport);
    assert.ok(Math.abs(converted.points[0].x-original.points[0].x)<1e-9);assert.ok(Math.abs(converted.points[0].y-original.points[0].y)<1e-9);assert.ok(Math.abs(converted.width-original.width)<1e-9);
  }
});
test('underline orientation is retained when viewing/exporting at another rotation',()=>{
  const page=pageModel(),mark={id:'u',kind:'underline' as const,rotation:90,pageNumber:1,color:'#112233',text:'text',rects:[{x:100,y:100,width:20,height:90}],createdAt:1};
  const shape=pdfMarkShapes(mark,page,page.getViewport({scale:1}))[0];assert.ok(shape.width<2);assert.ok(shape.height>80);
});
test('v2 refuses damaged/future data and a changed PDF page count',()=>{
  const good:PdfAnnotationFile={version:2,kind:'pdf',coordinateSpace:'pdf-user-space',sourcePath:'test.pdf',sourceMtime:1,pageCount:1,strokes:[{...line('a'),pageNumber:1}],pdfTextAnnotations:[],updatedAt:1};
  assert.deepEqual(validatePdfAnnotation(good,'test.pdf',1),good);
  for(const bad of [{...good,version:3},{...good,pageCount:2},{...good,strokes:[{...good.strokes[0],points:[{x:NaN,y:1,t:1,pressure:1}]}]},{...good,strokes:[...good.strokes,...good.strokes]}])assert.throws(()=>validatePdfAnnotation(bad,'test.pdf',1));
});
test('migration backup precedes the first v2 write; failed writes and stale sessions preserve data',async()=>{
  const disk=new Map<string,string>(),file=new TFile('test.pdf');let failing=false;
  const app:any={vault:{getAbstractFileByPath:()=>file,adapter:{exists:async(p:string)=>disk.has(p),mkdir:async()=>{},read:async(p:string)=>disk.get(p)!,write:async(p:string,s:string)=>{if(failing&&p.endsWith('.ink.json'))throw new Error('full');disk.set(p,s);}}}};
  const store=new StrokeStore(app,{manifest:{id:'test'}} as any),path=store.getAnnotationPath(file.path),raw=JSON.stringify(legacy([line('saved')],480));disk.set(path,raw);
  const pdf:PdfDocument={numPages:1,getPage:async()=>pageModel(),getData:async()=>new Uint8Array()};const loaded=await store.loadPdf(file.path,pdf);
  assert.equal(disk.get(path),raw);failing=true;await assert.rejects(store.savePdf(loaded.annotation,loaded.raw),/full/);assert.equal(disk.get(path),raw);
  assert.equal([...disk].filter(([p])=>p.endsWith('.bak')).length,1);assert.equal([...disk].find(([p])=>p.endsWith('.bak'))![1],raw);
  failing=false;const saved=await store.savePdf(loaded.annotation,loaded.raw);assert.equal(JSON.parse(saved).version,2);await assert.rejects(store.savePdf(loaded.annotation,raw),/別の画面/);assert.equal(disk.get(path),saved);
  disk.set(path,'{"version":3}');await assert.rejects(store.loadPdf(file.path,pdf));assert.equal(disk.get(path),'{"version":3}');
  const damaged=legacy([],480);damaged.pdfTextAnnotations=[{id:'bad-mark',kind:'highlight',pageNumber:1,color:'#112233',text:'text',createdAt:1,rects:[{x:1,y:1,width:-1,height:20}]}];
  const damagedRaw=JSON.stringify(damaged);disk.set(path,damagedRaw);await assert.rejects(store.loadPdf(file.path,pdf),/旧文字注釈/);assert.equal(disk.get(path),damagedRaw);
});

import {eraseStrokes} from '../src/ink/eraser';
test('partial eraser sweeps fast movements and preserves original ink and history',()=>{
 const s:InkStroke={id:'line',tool:'pen',color:'#112233',width:12,points:[{x:0,y:50,t:0,pressure:1},{x:100,y:50,t:20,pressure:1}]};
 const after=eraseStrokes([s],{x:50,y:0},{x:50,y:100},6,'partial');
 assert.equal(after.length,1);assert.deepEqual(after[0].points,s.points);assert.equal(s.erasures,undefined);
 assert.deepEqual(after[0].erasures,[{radius:6,points:[{x:50,y:0},{x:50,y:100}]}]);
 const change=strokeChange([s],after);assert.equal(change.removed.length,1);assert.equal(change.added.length,1);
 assert.deepEqual(applyStrokeChange(after,change,false),[s]);assert.deepEqual(applyStrokeChange([s],change),after);
 assert.equal(eraseStrokes(after,{x:50,y:20},{x:50,y:80},4,'partial')[0],after[0]);
 assert.deepEqual(eraseStrokes([s],{x:50,y:0},{x:50,y:100},6,'stroke'),[]);
 assert.equal(eraseStrokes([s],{x:50,y:90},{x:50,y:100},6,'partial')[0],s);
});
test('eraser includes visible width and follows midpoint curves',()=>{
 const s:InkStroke={id:'wide',tool:'highlighter',color:'#112233',width:20,points:[{x:0,y:0,t:0,pressure:1},{x:100,y:0,t:1,pressure:1}]};
 assert.equal(eraseStrokes([s],{x:50,y:12},{x:50,y:12},3,'stroke').length,0);
 assert.equal(eraseStrokes([s],{x:50,y:14},{x:50,y:14},3,'stroke')[0],s);
});
test('cutout coordinates roundtrip across zoom and all rotations',()=>{
 const original={...line('cut'),pageNumber:1,erasures:[{radius:9,points:[{x:60,y:70},{x:90,y:120}]}]};
 for(const rotation of [0,90,180,270]){
  const page=pageModel(rotation);
  const viewport=page.getViewport({scale:2.3,rotation});
  const restored=toPdfStroke(toViewportStroke(original,viewport),1,viewport);
  assert.ok(Math.abs(restored.erasures![0].radius-9)<1e-8);
  restored.erasures![0].points.forEach((p,i)=>{assert.ok(Math.abs(p.x-original.erasures[0].points[i].x)<1e-8);assert.ok(Math.abs(p.y-original.erasures[0].points[i].y)<1e-8);});
 }
});
test('invalid cutout data is refused instead of silently restoring erased ink',()=>{
 const good:PdfAnnotationFile={version:2,kind:'pdf',coordinateSpace:'pdf-user-space',sourcePath:'test.pdf',sourceMtime:1,pageCount:1,strokes:[{...line('cut'),pageNumber:1,erasures:[{radius:5,points:[{x:1,y:2}]}]}],pdfTextAnnotations:[],updatedAt:1};
 assert.deepEqual(validatePdfAnnotation(good,'test.pdf',1),good);
 for(const erasures of [null,[{radius:NaN,points:[{x:1,y:2}]}],[{radius:5,points:[]}],[{radius:5,points:[{x:Infinity,y:2}]}]]){
  const bad=structuredClone(good);(bad.strokes[0] as any).erasures=erasures;assert.throws(()=>validatePdfAnnotation(bad,'test.pdf',1));
 }
});
