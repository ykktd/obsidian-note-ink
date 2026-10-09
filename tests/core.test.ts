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
