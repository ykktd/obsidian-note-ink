import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit} from '@playwright/test';
import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
const output='work/resolution-browser';await mkdir(output,{recursive:true});
let archive=process.env.NOTE_INK_OBSIDIAN_ASAR;
if(!archive){const dir=path.join(homedir(),'Library/Application Support/obsidian');const files=(await readdir(dir)).filter(n=>/^obsidian-[\d.]+\.asar$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));archive=path.join(dir,files.at(-1));}
const bytes=await readFile(archive),header=JSON.parse(bytes.subarray(16,16+bytes.readUInt32LE(12)).toString()),offset=8+bytes.readUInt32LE(4),assets=new Map();
for(const name of ['pdf.min.mjs','pdf.worker.min.mjs','pdf.viewer.min.mjs','app.css']){const f=name==='app.css'?header.files[name]:header.files.lib.files.pdfjs.files[name];assets.set(`/native/${name}`,bytes.subarray(offset+Number(f.offset),offset+Number(f.offset)+f.size));}
await build({plugins:[pdfAssetsPlugin],entryPoints:['tests/nativePdfHarness.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['/native/*','/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:`${output}/harness.mjs`});
const html='<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native/app.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#f2f3f5;font-family:system-ui}:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--text-on-accent:#fff;--background-modifier-border:#ddd;--page-margin:0 auto 12px;--page-border:none;--page-bg-color:#fff}main{height:100vh;display:flex;flex-direction:column}header.view-header{display:flex;min-height:48px;gap:12px;padding:4px 12px}header button{height:40px}.view-content{flex:1;min-height:0}.test-native-container{position:absolute;inset:0;overflow:auto;touch-action:pan-x pan-y pinch-zoom}.notice{position:fixed;top:48px;right:10px;padding:10px;background:#333;color:white;z-index:80}.test-menu{position:fixed;top:100px;left:200px;display:flex;flex-direction:column;z-index:100;background:white;border:1px solid #ddd;padding:10px}.modal-content{position:fixed;top:150px;left:100px;background:white;z-index:100;padding:20px}</style></head><body class="theme-light show-view-header"><script type="module" src="/harness.mjs"></script></body></html>';
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const asset=assets.get(url);res.setHeader('Content-Type',url.endsWith('.css')?'text/css':'text/javascript');if(asset){res.end(asset);return;}res.end(await readFile(url==='/styles.css'?'styles.css':`${output}/harness.mjs`));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browsers=[];
try { for(const [name,type] of [['chromium',chromium],['webkit',webkit]]) {
 const browser=await type.launch(name==='chromium'?{channel:'chrome'}:{});browsers.push(browser);
 const page=await browser.newPage({viewport:{width:820,height:1000},deviceScaleFactor:2,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeReady);
 await page.evaluate(()=>window.nativeHarness.open([595.28,841.89]));
 const cropped=await page.evaluate(()=>window.nativeHarness.rasterChecks());
 // Canvas backends can antialias a few curve/eraser edge pixels differently
 // at different mask sizes. Require <0.01% coverage error and no missing pixels.
 for(const result of cropped){assert.ok(result.coverageError<.0001&&result.maxAlphaDifference<64,JSON.stringify(result));assert.ok(result.visible>100,JSON.stringify(result));}
 await page.evaluate(()=>{
  window.inkMetrics=(c)=>{const r=c.getBoundingClientRect();return {width:c.width,height:c.height,density:Math.min(c.width/r.width,c.height/r.height),pixels:c.width*c.height,left:r.left,top:r.top};};
  window.viewMetrics=(n=window.nativeHarness.viewer.currentPageNumber)=>{const h=window.nativeHarness,p=h.viewer.getPageView(n-1),c=p.div.querySelector('.note-ink-native-overlay canvas');return {...window.inkMetrics(c),...h.snapshot(),scale:h.viewer.currentScale};};
 });
 const original=await page.evaluate(()=>JSON.stringify(window.nativeHarness.session.controller.getStrokes()));
 const samples=[];
 for(const n of [1,2,7]) for(const scale of [.5,1,2,4,8]) {
  await page.evaluate(({n,scale})=>{const v=window.nativeHarness.viewer;v.currentScale=scale;v.currentPageNumber=n;v.update();},{n,scale});
  await page.waitForFunction(n=>window.nativeHarness.viewer.getPageView(n-1).renderingState===3,n);
  await page.evaluate(n=>{const v=window.nativeHarness.viewer,p=v.getPageView(n-1),r=p.div.getBoundingClientRect(),c=v.container,cr=c.getBoundingClientRect();c.scrollTop+=r.top-cr.top+Math.max(0,(r.height-c.clientHeight)/2);c.scrollLeft=Math.max(0,(p.div.clientWidth-c.clientWidth)/2);v.update();},n);
  await page.waitForFunction(n=>window.nativeHarness.viewer.getPageView(n-1).div.querySelector('.note-ink-native-overlay canvas')?.width>0,n);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const sample=await page.evaluate(n=>window.viewMetrics(n),n);samples.push(sample);
  assert.ok(sample.density>1.8,JSON.stringify(sample));assert.ok(sample.pixels<=6_000_000,JSON.stringify(sample));
 }
 assert.equal(await page.evaluate(()=>JSON.stringify(window.nativeHarness.session.controller.getStrokes())),original);
 // Scroll across both axes at high zoom: the bitmap follows the visible portion.
 const scroll=[];
 await page.evaluate(()=>{const v=window.nativeHarness.viewer;v.currentScale=4;v.currentPageNumber=1;v.update();});await page.waitForFunction(()=>window.nativeHarness.viewer.getPageView(0).renderingState===3);
 await page.evaluate(()=>{const v=window.nativeHarness.viewer;v.currentPageNumber=1;v.container.scrollTop=0;v.container.scrollLeft=0;v.update();});
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 for(const [dx,dy]of [[0,0],[240,330],[-180,-210]]) {
  await page.evaluate(([dx,dy])=>{const c=window.nativeHarness.viewer.container;c.scrollLeft+=dx;c.scrollTop+=dy;},[dx,dy]);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const sample=await page.evaluate(()=>window.viewMetrics(1));scroll.push(sample);assert.ok(sample.density>1.8,JSON.stringify(sample));
 }
 // Writing, the cropped display, and stored PDF coordinates must all agree.
 const writing=await page.evaluate(async()=>{
  const h=window.nativeHarness,v=h.viewer,p=v.getPageView(0),c=v.container,cr=c.getBoundingClientRect(),r=p.div.getBoundingClientRect();
  const x=cr.left+c.clientWidth*.48,y=cr.top+c.clientHeight*.48;
  const base=p.pdfPage.getViewport({scale:1,rotation:p.viewport.rotation});
  const expected=base.convertToPdfPoint((x-r.left)/r.width*base.width,(y-r.top)/r.height*base.height);
  h.session.controller.setToolState({tool:'pen',color:'#111111',width:2});
  const send=(type,dx=0,dy=0)=>p.div.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'pen',pointerId:70,button:0,buttons:type==='pointerup'?0:1,pressure:.5,clientX:x+dx,clientY:y+dy}));
  send('pointerdown');for(let i=1;i<=12;i++)send('pointermove',i*4,Math.sin(i/2)*10);send('pointerup',52,0);
  await new Promise(r=>requestAnimationFrame(r));
  const stroke=h.session.controller.getStrokes().at(-1),committed=p.div.querySelector('.note-ink-native-committed'),during=window.inkMetrics(committed);
  const live=p.div.querySelector('.note-ink-native-live'),liveMetrics=window.inkMetrics(live);
  const before=committed.getContext('2d').getImageData(0,0,committed.width,committed.height).data;
  const displayPixels=p.div.querySelector('.note-ink-native-overlay canvas').width;
  c.dispatchEvent(new Event('scroll'));await new Promise(r=>requestAnimationFrame(r));
  const display=p.div.querySelector('.note-ink-native-overlay canvas'),after=display.getContext('2d').getImageData(0,0,display.width,display.height).data;
  let difference=0,visible=0;for(let i=0;i<before.length;i++){if(before[i]!==after[i])difference++;if(i%4===3&&before[i])visible++;}
  return {expected,actual:[stroke.points[0].x,stroke.points[0].y],during,live:liveMetrics,after:window.inkMetrics(display),difference,visible,displayPixels,strokeCount:h.snapshot().strokes};
 });
 assert.ok(Math.hypot(...writing.actual.map((x,i)=>x-writing.expected[i]))<.001,JSON.stringify(writing));
 assert.ok(writing.during.density>1.8);assert.ok(writing.live.density>1.8);
 assert.equal(writing.during.width,writing.after.width);assert.equal(writing.during.height,writing.after.height);
 assert.equal(writing.difference,0,JSON.stringify(writing));assert.equal(writing.displayPixels,0);
 assert.ok(writing.visible>100);
 assert.equal(writing.strokeCount,5001);
 await page.screenshot({path:`${output}/${name}-zoomed-ink.png`});
 // Resize a split pane, then change the output device ratio without editing ink.
 await page.setViewportSize({width:700,height:850});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const resized=await page.evaluate(()=>window.viewMetrics());assert.ok(resized.density>1.8);
 const dpr=await page.evaluate(async()=>{Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:1});window.dispatchEvent(new Event('resize'));await new Promise(r=>requestAnimationFrame(r));return window.viewMetrics();});
 assert.ok(dpr.density>.98&&dpr.density<1.02,JSON.stringify(dpr));
 await page.evaluate(()=>{Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:2});window.dispatchEvent(new Event('resize'));});
 const saved=await page.evaluate(()=>window.nativeHarness.saveReload());assert.equal(saved.reloaded,5001);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const reloaded=await page.evaluate(()=>window.viewMetrics());assert.ok(reloaded.density>1.8);
 assert.deepEqual(errors,[]);
 await writeFile(`${output}/${name}-checks.json`,JSON.stringify({cropped,samples,scroll,writing,resized,dpr,reloaded,errors},null,2));
 console.log(name,JSON.stringify({cases:samples.length,minDensity:Math.min(...samples.map(s=>s.density)),maxDisplayPixels:Math.max(...samples.map(s=>s.pixels)),writing,resizedDensity:resized.density,reloadedDensity:reloaded.density}));
 await browser.close();
}} finally {for(const b of browsers)await b.close();server.close();}
