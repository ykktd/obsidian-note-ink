import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit} from '@playwright/test';
import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
const output='work/pinch-browser';await mkdir(output,{recursive:true});
let archive=process.env.NOTE_INK_OBSIDIAN_ASAR;
if(!archive){const dir=path.join(homedir(),'Library/Application Support/obsidian');const files=(await readdir(dir)).filter(n=>/^obsidian-[\d.]+\.asar$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));archive=path.join(dir,files.at(-1));}
const bytes=await readFile(archive),header=JSON.parse(bytes.subarray(16,16+bytes.readUInt32LE(12)).toString()),offset=8+bytes.readUInt32LE(4),assets=new Map();
for(const name of ['pdf.min.mjs','pdf.worker.min.mjs','pdf.viewer.min.mjs','app.css']){const f=name==='app.css'?header.files[name]:header.files.lib.files.pdfjs.files[name];assets.set(`/native/${name}`,bytes.subarray(offset+Number(f.offset),offset+Number(f.offset)+f.size));}
await build({plugins:[pdfAssetsPlugin],entryPoints:['tests/nativePdfHarness.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['/native/*','/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:`${output}/harness.mjs`});
const html='<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native/app.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#f2f3f5;font-family:system-ui}:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--text-on-accent:#fff;--background-modifier-border:#ddd;--page-margin:0 auto 12px;--page-border:none;--page-bg-color:#fff}main{height:100vh;display:flex;flex-direction:column}header{display:flex;min-height:48px;gap:12px;padding:4px 12px}header button{height:40px}.view-content{flex:1;min-height:0}.test-native-container{position:absolute;inset:0;overflow:auto;touch-action:pan-x pan-y pinch-zoom}.notice{position:fixed;top:48px;right:10px;padding:10px;background:#333;color:white;z-index:80}.test-menu{position:fixed;top:100px;left:200px;display:flex;flex-direction:column;z-index:100;background:white;border:1px solid #ddd;padding:10px}.modal-content{position:fixed;top:150px;left:100px;background:white;z-index:100;padding:20px}</style></head><body class="theme-light is-mobile is-tablet"><script type="module" src="/harness.mjs"></script></body></html>';
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const asset=assets.get(url);res.setHeader('Content-Type',url.endsWith('.css')?'text/css':'text/javascript');if(asset){res.end(asset);return;}res.end(await readFile(url==='/styles.css'?'styles.css':`${output}/harness.mjs`));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browsers=[];


try { for (const [name,type] of [['chromium',chromium],['webkit',webkit]]) {
 const browser=await type.launch(name==='chromium'?{channel:'chrome'}:{});browsers.push(browser);
 const page=await browser.newPage({viewport:{width:820,height:1000},deviceScaleFactor:1,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeReady);await page.evaluate(()=>window.nativeHarness.open());
 const results=[];
 for(const pageNumber of [1,4,7,20]) {
  for(const moving of [false,true]) {
   await page.evaluate(n=>{const h=window.nativeHarness;h.viewer.currentScale=2.4;h.viewer.currentPageNumber=n;h.viewer.update();},pageNumber);
   await page.waitForTimeout(220);
   const result=await page.evaluate(async({pageNumber,moving})=>{
    const h=window.nativeHarness,v=h.viewer,c=v.container,p=v.getPageView(pageNumber-1).div;
    const fx=moving?.37:.5,fy=moving?.57:.5;
    const cr=c.getBoundingClientRect(),pr=p.getBoundingClientRect();
    c.scrollTop+=pr.top+pr.height*fy-(cr.top+c.clientHeight*.45);
    c.scrollLeft+=pr.left+pr.width*fx-(cr.left+c.clientWidth*.5);
    await new Promise(r=>requestAnimationFrame(r));v.update();
    const rect=p.getBoundingClientRect(),x=rect.left+rect.width*fx,y=rect.top+rect.height*fy;
    let competingMoves=0;const competitor=()=>competingMoves++;c.addEventListener('touchmove',competitor);
    function send(type,factor=1,dx=0,dy=0,ids=[1,2]) {
     const ts=ids.map((identifier,i)=>({identifier,target:p,clientX:x+dx+(i?60:-60)*factor,clientY:y+dy}));
     const list=Object.assign(ts,{item:i=>ts[i]});const event=new Event(type,{bubbles:true,cancelable:true});
     for(const key of ['touches','targetTouches','changedTouches'])Object.defineProperty(event,key,{value:list});p.dispatchEvent(event);return event.defaultPrevented;
    }
    const started=send('touchstart');const samples=[];
    for(const [factor,dx,dy] of [[1.2,0,0],[1.55,35,45],[1.55,60,70],[1.3,20,25],[1,0,0]]) {
     send('touchmove',factor,moving?dx:0,moving?dy:0);
     await new Promise(r=>requestAnimationFrame(r));
     const r=p.getBoundingClientRect();samples.push({factor,error:Math.hypot(r.left+r.width*fx-x-(moving?dx:0),r.top+r.height*fy-y-(moving?dy:0)),scale:v.currentScale});
    }
    send('touchend',1,0,0,[]);await new Promise(r=>setTimeout(r,250));
    const end=p.getBoundingClientRect();c.removeEventListener('touchmove',competitor);
    // Cancel and a fresh gesture must also restore ordinary input.
    send('touchstart');send('touchcancel',1,0,0,[]);send('touchstart');send('touchend',1,0,0,[]);
    return {pageNumber,moving,started,samples,competingMoves,endError:Math.hypot(end.left+end.width*fx-x,end.top+end.height*fy-y),overflowAnchor:c.style.getPropertyValue('overflow-anchor'),inputEnabled:h.session.controller.enabled};
   },{pageNumber,moving});
   results.push(result);
   assert.ok(result.started);assert.equal(result.competingMoves,0);assert.equal(result.overflowAnchor,'');assert.ok(result.inputEnabled);
   assert.ok(result.samples.every(s=>s.error<2),JSON.stringify(result));assert.ok(result.endError<2,JSON.stringify(result));
  }
 }
 await page.screenshot({path:`${output}/${name}-pinch.png`});
 // Closing the session removes the handlers; normal PDF touch handling resumes.
 const cleanup=await page.evaluate(async()=>{const h=window.nativeHarness;await h.session.close();const p=h.viewer.getPageView(h.viewer.currentPageNumber-1).div;const ts=Object.assign([{identifier:1,target:p,clientX:200,clientY:300},{identifier:2,target:p,clientX:300,clientY:300}],{item(i){return this[i];}});const e=new Event('touchstart',{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:ts});p.dispatchEvent(e);return e.defaultPrevented;});
 assert.equal(cleanup,false);assert.deepEqual(errors,[]);
 await writeFile(`${output}/${name}-checks.json`,JSON.stringify(results,null,2));
 console.log(name,JSON.stringify({cases:results.length,maxError:Math.max(...results.flatMap(r=>r.samples.map(s=>s.error))),cleanup:true}));
 await browser.close();
}} finally {for(const b of browsers)await b.close();server.close();}
