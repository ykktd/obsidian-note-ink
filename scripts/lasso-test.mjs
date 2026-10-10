import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit} from '@playwright/test';
import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
const output='work/lasso-browser';await mkdir(output,{recursive:true});
let archive=process.env.NOTE_INK_OBSIDIAN_ASAR;
if(!archive){const dir=path.join(homedir(),'Library/Application Support/obsidian');const files=(await readdir(dir)).filter(n=>/^obsidian-[\d.]+\.asar$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));archive=path.join(dir,files.at(-1));}
const bytes=await readFile(archive),header=JSON.parse(bytes.subarray(16,16+bytes.readUInt32LE(12)).toString()),offset=8+bytes.readUInt32LE(4),assets=new Map();
for(const name of ['pdf.min.mjs','pdf.worker.min.mjs','pdf.viewer.min.mjs','app.css']){const f=name==='app.css'?header.files[name]:header.files.lib.files.pdfjs.files[name];assets.set(`/native/${name}`,bytes.subarray(offset+Number(f.offset),offset+Number(f.offset)+f.size));}
await build({plugins:[pdfAssetsPlugin],entryPoints:['tests/nativePdfHarness.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['/native/*','/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:`${output}/harness.mjs`});
const html='<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native/app.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#f2f3f5;font-family:system-ui}:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--text-on-accent:#fff;--background-modifier-border:#ddd;--page-margin:0 auto 12px;--page-border:none;--page-bg-color:#fff}.theme-dark{--background-primary:#202020;--background-secondary:#303030;--text-normal:#eee;--text-muted:#aaa;--background-modifier-border:#555}main{height:100vh;display:flex;flex-direction:column}header{display:flex;min-height:48px;gap:12px;padding:4px 12px}header button{height:40px}.view-content{flex:1;min-height:0}.test-native-container{position:absolute;inset:0;overflow:auto;touch-action:pan-x pan-y pinch-zoom}.notice{position:fixed;top:48px;right:10px;padding:10px;background:#333;color:white;z-index:80}.test-menu{position:fixed;top:100px;left:200px;display:flex;flex-direction:column;z-index:100;background:white;border:1px solid #ddd;padding:10px}.modal-content{position:fixed;top:150px;left:100px;background:white;z-index:100;padding:20px}</style></head><body class="theme-light is-mobile is-tablet"><script type="module" src="/harness.mjs"></script></body></html>';
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const asset=assets.get(url);res.setHeader('Content-Type',url.endsWith('.css')?'text/css':'text/javascript');if(asset){res.end(asset);return;}res.end(await readFile(url==='/styles.css'?'styles.css':`${output}/harness.mjs`));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browsers=[];


try{for(const [name,type]of [['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.NOTE_INK_TEST_BROWSER||process.env.NOTE_INK_TEST_BROWSER===name)){
 const browser=await type.launch(name==='chromium'?{channel:'chrome'}:{});browsers.push(browser);
 const page=await browser.newPage({viewport:{width:1024,height:900},hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeReady);await page.evaluate(()=>window.nativeHarness.open());
 await page.waitForFunction(()=>window.nativeHarness.viewer.getPageView(0).renderingState===3);
 await page.evaluate(()=>{const h=window.nativeHarness;h.viewer.currentScale=1.7;h.viewer.update();h.session.controller.replaceStrokes([
 {id:'a',pageNumber:1,tool:'pen',color:'#e93b4a',width:4,points:[{x:70,y:220,t:1,pressure:.7},{x:140,y:220,t:2,pressure:.7}],erasures:[{radius:5,points:[{x:105,y:220}]}]},
 {id:'b',pageNumber:1,tool:'highlighter',color:'#ffd54a',width:10,points:[{x:70,y:190,t:1,pressure:.7},{x:140,y:190,t:2,pressure:.7}]},
 {id:'other',pageNumber:1,tool:'pen',color:'#111111',width:3,points:[{x:270,y:170,t:1,pressure:.7},{x:300,y:170,t:2,pressure:.7}]},
 {id:'page2',pageNumber:2,tool:'pen',color:'#111111',width:3,points:[{x:70,y:190,t:1,pressure:.7},{x:140,y:190,t:2,pressure:.7}]}]);});
 await page.waitForTimeout(150);
 const strokes=()=>page.evaluate(()=>window.nativeHarness.session.controller.getStrokes());
 const before=await strokes();await page.getByRole('button',{name:'投げ縄選択',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'閲覧・文字選択',exact:true}).count(),0);
 async function gesture(coords,cancel=false){await page.evaluate(({coords,cancel})=>{const h=window.nativeHarness,p=coords.map(([x,y])=>h.point(1,x,y)),target=document.elementFromPoint(p[0].x,p[0].y),root=target.closest('.page');for(let i=0;i<p.length;i++)(i===0?target:root).dispatchEvent(new PointerEvent(i===0?'pointerdown':i===p.length-1?(cancel?'pointercancel':'pointerup'):'pointermove',{bubbles:true,cancelable:true,view:window,pointerId:91,pointerType:'pen',button:0,buttons:i===p.length-1?0:1,clientX:p[i].x,clientY:p[i].y}));},{coords,cancel});}
 await gesture([[55,240],[155,240],[155,170],[55,170],[55,240]]);

 assert.equal(await page.locator('.note-ink-lasso-panel').count(),0);
 assert.equal(await page.getByRole('button',{name:'ページ内を全選択',exact:true}).count(),0);
 assert.equal(await page.locator('[data-lasso-handle^=scale-]').count(),4);
 await page.screenshot({path:`${output}/${name}-selection.png`});
 await gesture([[90,210],[100,200],[110,195]]);
 let moved=await strokes();assert.ok(Math.abs(moved[0].points[0].x-90)<.01);assert.ok(Math.abs(moved[0].points[0].y-205)<.01);assert.deepEqual(moved.slice(2),before.slice(2));
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.deepEqual(await strokes(),before);
 await page.getByRole('button',{name:'やり直す',exact:true}).click();assert.deepEqual(await strokes(),moved);
 if(name==='chromium'){
  const cdp=await page.context().newCDPSession(page),b=await page.locator('.note-ink-lasso-move').boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+4*i,y:y+2*i,id:1}]});
  await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.note-ink-native-overlay canvas')).visibility),'hidden');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.notDeepEqual(await strokes(),moved);
  await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.deepEqual(await strokes(),moved);
 }
 await gesture([[110,195],[160,210],[180,220]],true);assert.deepEqual(await strokes(),moved);
 async function dragHandle(handle,dx,dy){const b=await page.locator(`[data-lasso-handle=${handle}]`).boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:5});await page.mouse.up();}
 function bounds(s){const points=s.slice(0,2).flatMap(s=>s.points.map(p=>({x:p.x,y:p.y,w:s.width/2})));return {l:Math.min(...points.map(p=>p.x-p.w)),r:Math.max(...points.map(p=>p.x+p.w)),t:Math.min(...points.map(p=>p.y-p.w)),b:Math.max(...points.map(p=>p.y+p.w))};}
 for(const [corner,dx,dy]of [['nw',-15,-12],['ne',15,-12],['sw',-15,12],['se',15,12]]){
   const old=await strokes(),fa=(await page.locator('.note-ink-lasso-bounds').first().getAttribute('points')).split(' ').map(p=>p.split(',').map(Number));await dragHandle(`scale-${corner}`,dx,dy);const changed=await strokes(),fb=(await page.locator('.note-ink-lasso-bounds').first().getAttribute('points')).split(' ').map(p=>p.split(',').map(Number));assert.ok(changed[0].width>old[0].width);assert.deepEqual(changed.slice(2),before.slice(2));
   const opposite={nw:2,ne:3,sw:1,se:0}[corner];assert.ok(Math.hypot(fa[opposite][0]-fb[opposite][0],fa[opposite][1]-fb[opposite][1])<.01);
   await page.getByRole('button',{name:'元に戻す',exact:true}).click();
 }
 await dragHandle('scale-se',25,15);await dragHandle('rotate',30,10);
 const angle=Number(await page.locator('.note-ink-lasso-overlay').getAttribute('data-angle'));assert.ok(Math.abs(angle)>.05);
 const polygon=await page.locator('.note-ink-lasso-bounds').first().getAttribute('points');const corners=polygon.split(' ').map(p=>p.split(',').map(Number));assert.ok(Math.abs(corners[1][1]-corners[0][1])>1);
 await page.screenshot({path:`${output}/${name}-rotated-frame.png`});
 const beforeCorner=await page.locator('.note-ink-lasso-bounds').first().getAttribute('points');
 await dragHandle('scale-se',12,8);const afterCorner=await page.locator('.note-ink-lasso-bounds').first().getAttribute('points');
 const fixedBefore=beforeCorner.split(' ')[0].split(',').map(Number),fixedAfter=afterCorner.split(' ')[0].split(',').map(Number);assert.ok(Math.hypot(fixedBefore[0]-fixedAfter[0],fixedBefore[1]-fixedAfter[1])<.01);
 assert.ok(Math.abs(Number(await page.locator('.note-ink-lasso-overlay').getAttribute('data-angle'))-angle)<1e-9);
 const rotateSaved=await strokes(),moveBox=await page.locator('.note-ink-lasso-move').boundingBox(),mx=moveBox.x+moveBox.width/2,my=moveBox.y+moveBox.height/2;
 await page.mouse.move(mx,my);await page.mouse.down();await page.mouse.move(mx+20,my+10,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await strokes(),rotateSaved);
 const handled=await strokes();assert.notDeepEqual(handled,moved);assert.deepEqual(handled.slice(2),before.slice(2));
 const pixels=await page.evaluate(()=>window.nativeHarness.lassoExport());assert.ok(pixels[0][0]>160&&pixels[0][1]<130,JSON.stringify(pixels));assert.ok(!(pixels[1][0]>160&&pixels[1][1]<130),JSON.stringify(pixels));
 await page.getByRole('button',{name:'選択した書き込みをコピー',exact:true}).click();
 // Native right-click pastes centred at the specified page point.
 await page.evaluate(()=>{const h=window.nativeHarness,p=h.point(1,240,100);document.elementFromPoint(p.x,p.y).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y}));});
 await page.getByRole('button',{name:'貼り付け',exact:true}).click();let pasted=await strokes();assert.equal(pasted.length,6);
 const pasteCenter=await page.evaluate(()=>window.nativeHarness.session.lasso.frame.center);const vp=await page.evaluate(()=>window.nativeHarness.viewer.getPageView(0).pdfPage.getViewport({scale:1}).transform);assert.ok(Math.abs(pasteCenter.x-(vp[0]*240+vp[2]*100+vp[4]))<.7);assert.ok(Math.abs(pasteCenter.y-(vp[1]*240+vp[3]*100+vp[5]))<.7);
 await page.getByRole('button',{name:'選択した書き込みを削除',exact:true}).click();assert.equal((await strokes()).length,4);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal((await strokes()).length,6);
 // Finger long-press works without a contextmenu event; moving/pinching cancels it.
 async function touchStart(x=220,y=130){await page.evaluate(([x,y])=>{const p=window.nativeHarness.point(1,x,y);window.touchTarget=document.elementFromPoint(p.x,p.y);window.touchPoint=p;window.touchTarget.dispatchEvent(new PointerEvent('pointerdown',{view:window,bubbles:true,cancelable:true,pointerType:'touch',pointerId:123,button:0,buttons:1,clientX:p.x,clientY:p.y}));},[x,y]);}
 async function touchEnd(type='pointerup',dx=0){await page.evaluate(({type,dx})=>{const p=window.touchPoint;window.touchTarget.dispatchEvent(new PointerEvent(type,{view:window,bubbles:true,cancelable:true,pointerType:'touch',pointerId:123,button:0,buttons:type==='pointerup'?0:1,clientX:p.x+dx,clientY:p.y}));},{type,dx});}
 await touchStart();await touchEnd('pointermove',30);await page.waitForTimeout(650);assert.equal(await page.locator('.test-menu').count(),0);await touchEnd();
 await touchStart();await page.evaluate(()=>window.touchTarget.dispatchEvent(new PointerEvent('pointerdown',{view:window,bubbles:true,pointerType:'touch',pointerId:124,button:0})));await page.waitForTimeout(650);assert.equal(await page.locator('.test-menu').count(),0);await touchEnd();
 await touchStart();await page.waitForTimeout(650);await touchEnd();assert.equal(await page.locator('.test-menu').count(),1);await page.getByRole('button',{name:'貼り付け',exact:true}).click();assert.equal((await strokes()).length,8);
 // A finger tap outside clears selection without mutating ink.
 const preTap=await strokes();await touchStart(300,250);await touchEnd();assert.equal(await page.locator('[data-lasso-handle]').count(),0);assert.deepEqual(await strokes(),preTap);
 const saved=await strokes();await page.evaluate(()=>window.nativeHarness.saveReload());assert.deepEqual(JSON.parse(JSON.stringify(await strokes())),JSON.parse(JSON.stringify(saved)));
 await page.getByRole('button',{name:'投げ縄選択',exact:true}).click();
 await gesture([[55,240],[210,240],[210,150],[55,150],[55,240]]);
 await page.getByRole('button',{name:'選択した書き込みをコピー',exact:true}).click();
 await page.evaluate(()=>{const h=window.nativeHarness;h.viewer.pagesRotation=90;h.viewer.currentScale=1.3;h.viewer.update();});await page.waitForTimeout(250);
 await page.evaluate(()=>{const h=window.nativeHarness,p=h.point(1,160,120);document.elementFromPoint(p.x,p.y).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y}));});
 await page.getByRole('button',{name:'貼り付け',exact:true}).click();assert.deepEqual((await strokes()).find(s=>s.id==='page2'),before[3]);
 await page.setViewportSize({width:390,height:700});await page.waitForTimeout(200);await page.evaluate(()=>document.body.classList.replace('theme-light','theme-dark'));await page.waitForTimeout(200);
 assert.equal(await page.locator('[data-lasso-action=copy]').evaluate(el=>getComputedStyle(el).color),'rgb(34, 34, 34)');
 await page.screenshot({path:`${output}/${name}-narrow-selected-dark.png`});
 assert.equal(await page.locator('.note-ink-lasso-panel').count(),0);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.note-ink-lasso-overlay').count(),0);
 await page.getByRole('button',{name:'ペン',exact:true}).click();
 // Dense page: the gesture rasterizes once, retains controls, and commits only on release.
 await page.setViewportSize({width:1024,height:900});
 await page.evaluate(()=>{const h=window.nativeHarness;h.viewer.pagesRotation=0;h.viewer.currentScale=1.7;h.viewer.currentPageNumber=1;h.viewer.container.scrollTop=0;h.viewer.update();h.session.controller.replaceStrokes(Array.from({length:300},(_,i)=>({id:`dense-${i}`,pageNumber:1,tool:i%10===0?'highlighter':'pen',color:'#3344aa',width:1.5,points:Array.from({length:60},(_,j)=>({x:(i<200?70:270)+j*(i<200?100:20)/59,y:(i<200?180:80)+i%40*.8+Math.sin(j/5),t:j*8,pressure:.6}))})));});
 await page.waitForTimeout(150);await page.getByRole('button',{name:'投げ縄選択',exact:true}).click();await gesture([[50,235],[190,235],[190,170],[50,170],[50,235]]);
 const perf=await page.evaluate(async()=>{
   const h=window.nativeHarness,lasso=h.session.lasso,start={...lasso.diagnostics},original=h.session.controller.annotation.strokes;
   const p=h.point(1,120,200),target=document.querySelector('.note-ink-lasso-move'),root=target.closest('.page'),control=document.querySelector('[data-lasso-handle="scale-nw"]');
   const send=(type,x,y)=>root.dispatchEvent(new PointerEvent(type,{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:334,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
   target.dispatchEvent(new PointerEvent('pointerdown',{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:334,button:0,buttons:1,clientX:p.x,clientY:p.y}));
   const costs=[];for(let f=1;f<=12;f++){const t=performance.now();for(let i=1;i<=30;i++)send('pointermove',p.x+f*2+i/30,p.y+f);costs.push(performance.now()-t);await new Promise(r=>requestAnimationFrame(r));}
   const during={...lasso.diagnostics},stable=control===document.querySelector('[data-lasso-handle="scale-nw"]'),unchanged=original===h.session.controller.annotation.strokes;
   send('pointerup',p.x+25,p.y+12);return {builds:during.previewBuilds-start.previewBuilds,frames:during.previewFrames-start.previewFrames,commitsDuring:during.geometryCommits-start.geometryCommits,commitsAfter:lasso.diagnostics.geometryCommits-start.geometryCommits,stable,unchanged,handlerMs:costs.sort((a,b)=>a-b)[6]};
 });
 assert.equal(perf.builds,1);assert.ok(perf.frames<=12&&perf.frames>0);assert.equal(perf.commitsDuring,0);assert.equal(perf.commitsAfter,1);assert.ok(perf.stable&&perf.unchanged);
 const corner=await page.locator('.note-ink-lasso-corner').first().evaluate(el=>({target:el.getBoundingClientRect().width,visible:getComputedStyle(el,'::after').width}));assert.equal(corner.target,28);assert.equal(corner.visible,'10px');
 await page.screenshot({path:`${output}/${name}-dense-selection.png`});
 // Selection excludes erased tails and does not enforce a 44px minimum.
 await page.evaluate(()=>window.nativeHarness.session.controller.replaceStrokes([{id:'trimmed',pageNumber:1,tool:'highlighter',color:'#ffcc00',width:8,points:[{x:70,y:200,t:0,pressure:.7},{x:300,y:200,t:10,pressure:.7}],erasures:[{radius:20,points:[{x:150,y:200},{x:320,y:200}]}]}]));
 await gesture([[50,235],[330,235],[330,170],[50,170],[50,235]]);
 let fitted=await page.evaluate(()=>window.nativeHarness.session.lasso.frame);assert.ok(fitted.width<80&&fitted.width>55,JSON.stringify(fitted));
 await page.screenshot({path:`${output}/${name}-trimmed-bounds.png`});
 // Rotate through the cardinal directions, test capture, hold, release and exact commit.
 const snap=await page.evaluate(async()=>{
  const l=window.nativeHarness.session.lasso,f=structuredClone(l.frame),handle=document.querySelector('[data-lasso-handle="rotate"]'),root=handle.closest('.page'),rect=root.getBoundingClientRect(),v=window.nativeHarness.viewer.getPageView(0).pdfPage.getViewport({scale:1}),hb=handle.getBoundingClientRect();
  const center={x:rect.left+f.center.x*rect.width/v.width,y:rect.top+f.center.y*rect.height/v.height},x=hb.x+hb.width/2,y=hb.y+hb.height/2,r=Math.hypot(x-center.x,y-center.y),start=Math.atan2(y-center.y,x-center.x);
  handle.dispatchEvent(new PointerEvent('pointerdown',{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:441,button:0,buttons:1,clientX:x,clientY:y}));
  const values=[];for(const degrees of [87,96,99,177,186,189,267,276,279,357,366,369,360]){
   const a=start+degrees*Math.PI/180;root.dispatchEvent(new PointerEvent('pointermove',{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:441,button:0,buttons:1,clientX:center.x+Math.cos(a)*r,clientY:center.y+Math.sin(a)*r}));await new Promise(r=>requestAnimationFrame(r));values.push(Number(document.querySelector('.note-ink-lasso-overlay').dataset.angle)*180/Math.PI);
  }
  root.dispatchEvent(new PointerEvent('pointerup',{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:441,button:0,buttons:0,clientX:x,clientY:y}));return {values,final:l.frame.angle};
 });
 const expected=[90,90,99,180,180,189,270,270,279,0,0,9,0];snap.values.forEach((v,i)=>assert.ok(Math.abs(((v-expected[i]+540)%360)-180)<.01,JSON.stringify(snap)));assert.ok(Math.abs(Math.sin(snap.final))<1e-8);
 await page.evaluate(()=>window.nativeHarness.session.controller.replaceStrokes([{id:'dot',pageNumber:1,tool:'highlighter',color:'#ffcc00',width:2,points:[{x:100,y:200,t:0,pressure:.7}]}]));
 await gesture([[50,235],[190,235],[190,170],[50,170],[50,235]]);fitted=await page.evaluate(()=>window.nativeHarness.session.lasso.frame);assert.ok(fitted.width<10&&fitted.height<10,JSON.stringify(fitted));
 await page.screenshot({path:`${output}/${name}-small-bounds.png`});
 await page.evaluate(()=>window.nativeHarness.session.controller.replaceStrokes([{id:'erased',pageNumber:1,tool:'pen',color:'#000000',width:2,points:[{x:100,y:200,t:0,pressure:.7}],erasures:[{radius:20,points:[{x:100,y:200}]}]}]));
 await gesture([[50,235],[190,235],[190,170],[50,170],[50,235]]);assert.equal(await page.locator('[data-lasso-handle]').count(),0);
 await page.evaluate(()=>window.nativeHarness.session.close());assert.equal(await page.locator('.note-ink-lasso-overlay').count(),0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({browser:name,passed:true,fourCorners:true,drag:true,longPressPaste:true,pastePosition:true,outsideTap:true,undo:true,reload:true,perf,errors}));await browser.close();
}}finally{for(const b of browsers)await b.close();server.close();}
