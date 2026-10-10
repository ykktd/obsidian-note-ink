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
const html='<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native/app.css"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:#f2f3f5;font-family:system-ui}:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--text-on-accent:#fff;--background-modifier-border:#ddd;--page-margin:0 auto 12px;--page-border:none;--page-bg-color:#fff}main{height:100vh;display:flex;flex-direction:column}header{display:flex;min-height:48px;gap:12px;padding:4px 12px}header button{height:40px}.view-content{flex:1;min-height:0}.test-native-container{position:absolute;inset:0;overflow:auto;touch-action:pan-x pan-y pinch-zoom}.notice{position:fixed;top:48px;right:10px;padding:10px;background:#333;color:white;z-index:80}.test-menu{position:fixed;top:100px;left:200px;display:flex;flex-direction:column;z-index:100;background:white;border:1px solid #ddd;padding:10px}.modal-content{position:fixed;top:150px;left:100px;background:white;z-index:100;padding:20px}</style></head><body class="theme-light"><script type="module" src="/harness.mjs"></script></body></html>';
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost').pathname;if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const asset=assets.get(url);res.setHeader('Content-Type',url.endsWith('.css')?'text/css':'text/javascript');if(asset){res.end(asset);return;}res.end(await readFile(url==='/styles.css'?'styles.css':`${output}/harness.mjs`));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browsers=[];

try {for(const [name,type] of [['chromium',chromium],['webkit',webkit]]) {
 const browser=await type.launch(name==='chromium'?{channel:'chrome'}:{});browsers.push(browser);
 const page=await browser.newPage({viewport:{width:820,height:1000},deviceScaleFactor:1,hasTouch:true});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeReady);await page.evaluate(()=>window.nativeHarness.open());
 await page.evaluate(()=>{const h=window.nativeHarness;h.session.controller.replaceStrokes(Array.from({length:50},(_,i)=>({id:`marker-${i}`,pageNumber:i+1,tool:'pen',color:'#ff00ff',width:24,points:[{x:80+(i*17)%210,y:90+(i*13)%90,t:0,pressure:1}]})));h.session.controller.annotation.pdfTextAnnotations=[];});
 const results=[];
 for(const [scale,scroll,rotation,cssScale] of [[1,0,0,1],[.5,0,0,1],[.5,220,0,1],[1.7,500,0,1],[.6,0,0,1],[.6,0,90,1],[.6,0,180,1],[.6,0,270,1],[.6,0,0,.8]]) {
  await page.evaluate(([s,y,r,c])=>{const h=window.nativeHarness;h.viewer.pagesRotation=r;h.viewer.viewer.style.transform=`scale(${c})`;h.viewer.viewer.style.transformOrigin="top center";h.viewer.currentScale=s;h.viewer.container.scrollTop=y;h.viewer.update();},[scale,scroll,rotation,cssScale]);await page.waitForTimeout(500);
  const positions=await page.evaluate(()=>{const h=window.nativeHarness,b=h.viewer.container.getBoundingClientRect();return Array.from(h.viewer.getCachedPageViews()).map(p=>({n:p.id,...h.point(p.id,80+((p.id-1)*17)%210,90+((p.id-1)*13)%90)})).filter(p=>p.x>0&&p.x<820&&p.y>b.top+15&&p.y<850);});
  const png=await page.screenshot();await writeFile(`work/alignment-check/${name}-${scale}-${scroll}-${rotation}-${cssScale}.png`,png);
  const check=await page.evaluate(async([base64,pts])=>{const im=new Image();im.src='data:image/png;base64,'+base64;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);return pts.map(p=>{const a=Array.from(ctx.getImageData(Math.round(p.x),Math.round(p.y),1,1).data);return {...p,rgba:a,ok:a[0]>200&&a[1]<60&&a[2]>200};});},[png.toString('base64'),positions]);results.push({scale,scroll,rotation,cssScale,check});
 }
 await writeFile(`work/alignment-check/${name}-checks.json`,JSON.stringify(results,null,2));
 assert.ok(results.every(r=>r.check.length&&r.check.every(p=>p.ok)),JSON.stringify({name,results}));
 console.log(JSON.stringify({name,positions:results.flatMap(r=>r.check).length,passed:true}));await browser.close();
}}finally{for(const b of browsers)await b.close();server.close();}
