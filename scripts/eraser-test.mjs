import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit} from '@playwright/test';
import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
const output='work/native-browser';await mkdir(output,{recursive:true});
let archive=process.env.NOTE_INK_OBSIDIAN_ASAR;
if(!archive){const dir=path.join(homedir(),'Library/Application Support/obsidian');const files=(await readdir(dir)).filter(n=>/^obsidian-[\d.]+\.asar$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));archive=path.join(dir,files.at(-1));}
const bytes=await readFile(archive),header=JSON.parse(bytes.subarray(16,16+bytes.readUInt32LE(12)).toString()),offset=8+bytes.readUInt32LE(4),assets=new Map();
for(const name of ['pdf.min.mjs','pdf.worker.min.mjs','pdf.viewer.min.mjs','app.css']){const f=name==='app.css'?header.files[name]:header.files.lib.files.pdfjs.files[name];assets.set(`/native/${name}`,bytes.subarray(offset+Number(f.offset),offset+Number(f.offset)+f.size));}
await build({plugins:[pdfAssetsPlugin],entryPoints:['tests/nativePdfHarness.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['/native/*','/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:`${output}/harness.mjs`});
const html='<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native/app.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#f2f3f5;font-family:system-ui}:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--text-on-accent:#fff;--background-modifier-border:#ddd;--page-margin:0 auto 12px;--page-border:none;--page-bg-color:#fff}main{height:100vh;display:flex;flex-direction:column}header{display:flex;min-height:48px;gap:12px;padding:4px 12px}header button{height:40px}.view-content{flex:1;min-height:0}.test-native-container{position:absolute;inset:0;overflow:auto;touch-action:pan-x pan-y pinch-zoom}.notice{position:fixed;top:48px;right:10px;padding:10px;background:#333;color:white;z-index:80}.test-menu{position:fixed;top:100px;left:200px;display:flex;flex-direction:column;z-index:100;background:white;border:1px solid #ddd;padding:10px}.modal-content{position:fixed;top:150px;left:100px;background:white;z-index:100;padding:20px}</style></head><body class="theme-light is-mobile is-tablet"><script type="module" src="/harness.mjs"></script></body></html>';
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const asset=assets.get(url);res.setHeader('Content-Type',url.endsWith('.css')?'text/css':'text/javascript');if(asset){res.end(asset);return;}res.end(await readFile(url==='/styles.css'?'styles.css':`${output}/harness.mjs`));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browsers=[];

try{for(const [name,type]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await type.launch(name==='chromium'?{channel:'chrome'}:{});browsers.push(browser);
 const page=await browser.newPage({viewport:{width:820,height:1000},deviceScaleFactor:1,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeReady);await page.evaluate(()=>window.nativeHarness.open());
 await page.evaluate(()=>{const h=window.nativeHarness;h.viewer.currentScale=1.5;h.viewer.container.scrollTop=0;h.viewer.update();h.session.controller.annotation.pdfTextAnnotations=[];h.session.controller.replaceStrokes([1,2].map(n=>({id:`line-${n}`,pageNumber:n,tool:n===1?'pen':'highlighter',color:'#ff00ff',width:16,points:Array.from({length:23},(_,i)=>({x:60+i*10,y:150,t:i*10,pressure:1}))})));});await page.waitForTimeout(350);
 assert.equal(await page.locator('.note-ink-native-quick').count(),0);
 const sizes=await page.locator('.note-ink-native-tools button').evaluateAll(bs=>bs.filter(b=>b.getClientRects().length).map(b=>({button:b.getBoundingClientRect().width,icon:b.querySelector('svg').getBoundingClientRect().width})));assert.ok(sizes.every(s=>s.button>=44&&s.icon===24),JSON.stringify(sizes));
 const slider=page.locator('.note-ink-native-width input');await slider.focus();await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>window.nativeHarness.session.controller.getToolState().width),2.5);
 await page.locator('button[aria-label="消しゴム"]').click();assert.equal(await page.getByLabel('部分消去',{exact:true}).isChecked(),true);
 await slider.fill('12');await slider.dispatchEvent('input');
 await page.evaluate(()=>{const h=window.nativeHarness,a=h.point(1,170,110),b=h.point(1,170,190),target=document.elementFromPoint(a.x,a.y);for(const [type,p] of [['pointerdown',a],['pointermove',b]])target.dispatchEvent(new PointerEvent(type,{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:17,button:0,buttons:1,pressure:.7,clientX:p.x,clientY:p.y}));});
 const ring=await page.locator('.note-ink-eraser-cursor').evaluate(el=>({w:el.getBoundingClientRect().width,border:getComputedStyle(el).borderTopWidth,color:getComputedStyle(el).borderTopColor}));assert.ok(Math.abs(ring.w-48)<1);assert.equal(ring.border,'1px');
 await page.waitForTimeout(150);await page.screenshot({path:`${output}/${name}-eraser-cursor.png`});
 await page.evaluate(()=>{const h=window.nativeHarness,p=h.point(1,170,190);document.elementFromPoint(p.x,p.y).dispatchEvent(new PointerEvent('pointerup',{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:17,button:0,buttons:0,clientX:p.x,clientY:p.y}));});
 async function pixels(){await page.waitForTimeout(120);const pts=await page.evaluate(()=>[100,170,240].map(x=>window.nativeHarness.point(1,x,150)));const png=await page.screenshot();return page.evaluate(async([base64,pts])=>{const im=new Image();im.src='data:image/png;base64,'+base64;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);return pts.map(p=>Array.from(ctx.getImageData(Math.round(p.x),Math.round(p.y),1,1).data));},[png.toString('base64'),pts]);}
 const isInk=p=>p[0]>220&&p[1]<60&&p[2]>220;
 const partial=await pixels();assert.ok(isInk(partial[0])&&!isInk(partial[1])&&isInk(partial[2]),JSON.stringify(partial));
 assert.equal(await page.evaluate(()=>window.nativeHarness.session.controller.getStrokes().filter(s=>s.erasures?.length).length),1);
 const colours=await page.locator('.note-ink-native-tools button').evaluateAll(bs=>bs.filter(b=>b.getClientRects().length).map(b=>({pressed:b.getAttribute('aria-pressed'),background:getComputedStyle(b).backgroundColor,colour:getComputedStyle(b.querySelector('svg')).color})));
 const active=colours.find(b=>b.pressed==='true');assert.ok(active&&active.background!==colours[0].background&&active.colour!==active.background,JSON.stringify(colours));
 await page.locator('button[aria-label="元に戻す"]').click();assert.ok((await pixels()).every(isInk));
 await page.locator('button[aria-label="やり直す"]').click();assert.deepEqual(await pixels(),partial);
 for(const scale of [.7,2,1.5]){await page.evaluate(s=>{const h=window.nativeHarness;h.viewer.currentScale=s;h.viewer.container.scrollTop=0;h.viewer.update();},scale);await page.waitForTimeout(200);const p=await pixels();assert.ok(isInk(p[0])&&!isInk(p[1])&&isInk(p[2]),JSON.stringify({scale,p}));}
 await page.evaluate(()=>window.nativeHarness.saveReload());const saved=await pixels();assert.ok(isInk(saved[0])&&!isInk(saved[1])&&isInk(saved[2]));
 const exported=await page.evaluate(()=>window.nativeHarness.cutoutExport());assert.ok(isInk(exported[0])&&!isInk(exported[1])&&isInk(exported[2]),JSON.stringify(exported));

 await page.locator('button[aria-label="消しゴム"]').click();
 const fallback=await page.evaluate(()=>{const h=window.nativeHarness,a=h.point(1,100,110),b=h.point(1,100,190),target=document.elementFromPoint(a.x,a.y);let ring=false;
  for(const [type,p] of [['touchstart',a],['touchmove',b],['touchend',b]]){
   const touch={identifier:44,target,clientX:p.x,clientY:p.y,force:.7,radiusX:1,radiusY:1,touchType:'stylus'};
   const event=new Event(type,{bubbles:true,cancelable:true});for(const [k,v]of Object.entries({touches:type==='touchend'?[]:[touch],changedTouches:[touch],targetTouches:type==='touchend'?[]:[touch]}))Object.defineProperty(event,k,{value:Object.assign(v,{item:i=>v[i]})});target.dispatchEvent(event);
   if(type==='touchmove')ring=!!document.querySelector('.note-ink-eraser-cursor');
  }
  return {ring,ended:!h.session.controller.isInputActive()};
 });assert.ok(fallback.ring&&fallback.ended);const touched=await pixels();assert.ok(!isInk(touched[0])&&!isInk(touched[1])&&isInk(touched[2]),JSON.stringify(touched));
 await page.locator('button[aria-label="元に戻す"]').click();assert.deepEqual(await pixels(),saved);
 await page.getByLabel('ストローク消去',{exact:true}).check();await page.evaluate(()=>window.nativeHarness.pen(1,100,150));assert.equal(await page.evaluate(()=>window.nativeHarness.session.controller.getStrokes().some(s=>s.pageNumber===1)),false);assert.equal(await page.evaluate(()=>window.nativeHarness.session.controller.getStrokes().filter(s=>s.pageNumber===2).length),1);
 await page.locator('button[aria-label="元に戻す"]').click();await page.waitForTimeout(150);await page.screenshot({path:`${output}/${name}-new-tools.png`});
 await page.evaluate(()=>{document.body.classList.replace('theme-light','theme-dark');});await page.waitForTimeout(150);await page.screenshot({path:`${output}/${name}-dark-tools.png`});
 await page.evaluate(()=>{document.body.classList.replace('theme-dark','theme-light');});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);await page.screenshot({path:`${output}/${name}-narrow-tools.png`});const narrow=await page.locator('.note-ink-native-tools button').evaluateAll(bs=>bs.filter(b=>b.getClientRects().length).map(b=>b.getBoundingClientRect().width));assert.ok(narrow.every(w=>w>=44));
 assert.deepEqual(errors,[]);await writeFile(`${output}/${name}-eraser-checks.json`,JSON.stringify({sizes,colours,ring,partial,saved,exported,fallback,narrow,errors},null,2));console.log(JSON.stringify({name,partialErase:true,undoRedo:true,saveReload:true,export:true,sizes,ring}));await browser.close();
}}finally{for(const b of browsers)await b.close();server.close();}
