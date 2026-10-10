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
const html='<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native/app.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#f2f3f5;font-family:system-ui}:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--text-on-accent:#fff;--background-modifier-border:#ddd;--page-margin:0 auto 12px;--page-border:none;--page-bg-color:#fff}main{height:100vh;display:flex;flex-direction:column}header{display:flex;min-height:48px;gap:12px;padding:4px 12px}header button{height:40px}.view-content{flex:1;min-height:0}.test-native-container{position:absolute;inset:0;overflow:auto;touch-action:pan-x pan-y pinch-zoom}.notice{position:fixed;top:48px;right:10px;padding:10px;background:#333;color:white;z-index:80}.test-menu{position:fixed;top:100px;left:200px;display:flex;flex-direction:column;z-index:100;background:white;border:1px solid #ddd;padding:10px}.modal-content{position:fixed;top:150px;left:100px;background:white;z-index:100;padding:20px}</style></head><body class="theme-light is-mobile is-tablet"><script type="module" src="/harness.mjs"></script></body></html>';
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const asset=assets.get(url);res.setHeader('Content-Type',url.endsWith('.css')?'text/css':'text/javascript');if(asset){res.end(asset);return;}res.end(await readFile(url==='/styles.css'?'styles.css':`${output}/harness.mjs`));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browsers=[];


try{for(const [name,type]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await type.launch(name==='chromium'?{channel:'chrome'}:{});browsers.push(browser);
 const page=await browser.newPage({viewport:{width:1024,height:900},hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
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
 async function gesture(coords,cancel=false){await page.evaluate(({coords,cancel})=>{const h=window.nativeHarness,p=coords.map(([x,y])=>h.point(1,x,y)),target=document.elementFromPoint(p[0].x,p[0].y);for(let i=0;i<p.length;i++)target.dispatchEvent(new PointerEvent(i===0?'pointerdown':i===p.length-1?(cancel?'pointercancel':'pointerup'):'pointermove',{bubbles:true,cancelable:true,view:window,pointerId:91,pointerType:'pen',button:0,buttons:i===p.length-1?0:1,clientX:p[i].x,clientY:p[i].y}));},{coords,cancel});}
 await gesture([[55,240],[155,240],[155,170],[55,170],[55,240]]);
 assert.match(await page.locator('.note-ink-lasso-panel [role=status]').innerText(),/2本/);
 await page.screenshot({path:`${output}/${name}-selection.png`});
 await gesture([[90,210],[100,200],[110,195]]);
 let moved=await strokes();assert.ok(Math.abs(moved[0].points[0].x-90)<.01);assert.ok(Math.abs(moved[0].points[0].y-205)<.01);assert.deepEqual(moved.slice(2),before.slice(2));assert.ok(Math.abs(moved[0].erasures[0].points[0].x-125)<.01);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.deepEqual(await strokes(),before);
 await page.getByRole('button',{name:'やり直す',exact:true}).click();assert.deepEqual(await strokes(),moved);
 await gesture([[110,195],[160,210],[180,220]],true);assert.deepEqual(await strokes(),moved);
 await page.getByRole('button',{name:'拡大 ＋10%',exact:true}).click();let scaled=await strokes();assert.ok(Math.abs(scaled[0].width-4.4)<1e-8);assert.ok(Math.abs(scaled[0].erasures[0].radius-5.5)<1e-8);
 await page.getByRole('button',{name:'右に15°回転',exact:true}).click();let rotated=await strokes();assert.notEqual(rotated[0].points[0].y,rotated[0].points[1].y);assert.deepEqual(rotated.slice(2),before.slice(2));
 // Exercise the actual resize and rotation handles with mouse input.
 for(const [handle,dx,dy]of [['scale',25,15],['rotate',30,10]]){const b=await page.locator(`[data-lasso-handle=${handle}]`).boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:5});await page.mouse.up();}
 const handled=await strokes();assert.notDeepEqual(handled,rotated);assert.deepEqual(handled.slice(2),before.slice(2));
 const pixels=await page.evaluate(()=>window.nativeHarness.lassoExport());assert.ok(pixels[0][0]>160&&pixels[0][1]<130,JSON.stringify(pixels));assert.ok(!(pixels[1][0]>160&&pixels[1][1]<130),JSON.stringify(pixels));
 await page.getByRole('button',{name:'コピー',exact:true}).click();await page.getByRole('button',{name:'貼り付け',exact:true}).click();assert.equal((await strokes()).length,6);
 await page.getByRole('button',{name:'選択した書き込みを削除',exact:true}).click();assert.equal((await strokes()).length,4);
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal((await strokes()).length,6);
 // Reload persists all transformed coordinates and eraser masks exactly.
 const saved=await strokes();await page.evaluate(()=>window.nativeHarness.saveReload());assert.deepEqual(JSON.parse(JSON.stringify(await strokes())),JSON.parse(JSON.stringify(saved)));
 await page.getByRole('button',{name:'投げ縄選択',exact:true}).click();
 await page.evaluate(()=>{const h=window.nativeHarness;h.viewer.pagesRotation=90;h.viewer.currentScale=1.3;h.viewer.update();});await page.waitForTimeout(250);
 await page.getByRole('button',{name:'ページ内を全選択',exact:true}).click();assert.match(await page.locator('.note-ink-lasso-panel [role=status]').innerText(),/5本/);
 await page.getByRole('button',{name:'左に15°回転',exact:true}).click();assert.deepEqual((await strokes()).find(s=>s.id==='page2'),before[3]);
 // Finger contacts are not swallowed by lasso mode.
 assert.equal((await page.evaluate(()=>window.nativeHarness.finger())).prevented,false);
 await page.getByRole('button',{name:'ペン',exact:true}).click();assert.equal(await page.locator('.note-ink-lasso-overlay').count(),0);
 await page.getByRole('button',{name:'投げ縄選択',exact:true}).click();await page.setViewportSize({width:390,height:700});await page.waitForTimeout(200);
 const geometry=await page.locator('.note-ink-lasso-panel').boundingBox();assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.x+geometry.width<=391&&geometry.y+geometry.height<=701,JSON.stringify(geometry));
 await page.screenshot({path:`${output}/${name}-narrow.png`});
 await page.keyboard.press('Control+a');assert.match(await page.locator('.note-ink-lasso-panel [role=status]').innerText(),/5本/);
 await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');assert.equal((await strokes()).length,11);
 await page.keyboard.press('Delete');assert.equal((await strokes()).length,6);
 await page.keyboard.press('Control+a');await page.evaluate(()=>document.body.classList.replace('theme-light','theme-dark'));await page.waitForTimeout(150);
 const selectedPanel=await page.locator('.note-ink-lasso-panel').boundingBox();assert.ok(selectedPanel.x>=0&&selectedPanel.y>=0&&selectedPanel.x+selectedPanel.width<=391&&selectedPanel.y+selectedPanel.height<=701,JSON.stringify(selectedPanel));
 await page.screenshot({path:`${output}/${name}-narrow-selected-dark.png`});
 await page.keyboard.press('Escape');assert.equal(await page.locator('.note-ink-lasso-overlay').count(),0);
 await page.evaluate(()=>window.nativeHarness.session.close());assert.equal(await page.locator('.note-ink-lasso-overlay').count(),0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({browser:name,passed:true,selection:true,transform:true,undo:true,reload:true,rotation:true,errors}));await browser.close();
}}finally{for(const b of browsers)await b.close();server.close();}
