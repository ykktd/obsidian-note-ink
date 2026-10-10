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
 const page=await browser.newPage({viewport:{width:1024,height:900},deviceScaleFactor:1,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.nativeReady);await page.evaluate(()=>window.nativeHarness.open());await page.waitForTimeout(250);
 const grip=page.getByRole('button',{name:'ツールバーを移動',exact:true}),minimize=page.getByRole('button',{name:'ツールバーを最小化',exact:true}),restore=page.getByRole('button',{name:'注釈ツールバーを開く',exact:true});
 const eraser=page.getByRole('button',{name:'消しゴム',exact:true});
 async function geometry(){await page.waitForTimeout(100);return page.evaluate(()=>{const $=s=>document.querySelector(s),box=e=>e?{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}:null;return {host:box($('.note-ink-native-host')),bar:box($('.note-ink-native-tools')),panel:box($('.note-ink-eraser-modes')),heading:box($('.note-ink-eraser-heading')),anchor:box($('button[aria-label="消しゴム"]')),side:$('.note-ink-eraser-modes').dataset.side,panelHidden:$('.note-ink-eraser-modes').hidden,tool:window.nativeHarness.session.controller.getToolState(),minimized:$('.note-ink-native-tools').dataset.minimized==='true'};});}
 function inside(s){const b=s.host;for(const r of [s.bar,...(s.panelHidden?[]:[s.panel,s.heading])]){assert.ok(r.x>=b.x-1&&r.y>=b.y-1&&r.x+r.w<=b.x+b.w+1&&r.y+r.h<=b.y+b.h+1,JSON.stringify(s));}}
 function anchored(s){inside(s);assert.ok(Math.abs(s.panel.x+s.panel.w/2-(s.anchor.x+s.anchor.w/2))<2,JSON.stringify(s));assert.ok(s.heading.y>=s.panel.y&&s.heading.y+s.heading.h<=s.panel.y+s.panel.h);}
 async function drag(handle,dx,dy){const b=await handle.boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up();return geometry();}
 const start=await geometry();await eraser.click();let s=await geometry();anchored(s);assert.equal(s.side,'above');assert.deepEqual(s.bar,start.bar);
 const bottom=s;
 s=await drag(grip,70,-650);anchored(s);assert.equal(s.side,'below');assert.ok(s.bar.y<bottom.bar.y-400);const top=s;
 // Opening and closing the panel must not change the bar's position.
 await page.getByRole('button',{name:'ペン',exact:true}).click();assert.deepEqual((await geometry()).bar,top.bar);await eraser.click();assert.deepEqual((await geometry()).bar,top.bar);
 await page.screenshot({path:`${output}/${name}-toolbar-top.png`});
 s=await drag(grip,-1000,-500);anchored(s);assert.equal(s.side,'below');
 s=await drag(grip,2000,1300);anchored(s);assert.equal(s.side,'above');
 await page.getByLabel('ストローク消去',{exact:true}).check();const tool=(await geometry()).tool;
 const beforeMin=(await geometry()).bar;await minimize.click();s=await geometry();inside(s);assert.ok(s.minimized&&s.panelHidden&&s.bar.w<70&&s.bar.h<70);assert.deepEqual(s.tool,tool);
 // The compact bubble is draggable; releasing a drag must not expand it.
 s=await drag(restore,-80,-250);assert.ok(s.minimized);inside(s);const bubble=s.bar;
 await restore.click();s=await geometry();inside(s);assert.ok(!s.minimized&&!s.panelHidden);assert.deepEqual(s.tool,tool);assert.equal(s.bar.y,bubble.y);
 await grip.focus();const previous=s.bar;await page.keyboard.press('ArrowUp');s=await geometry();assert.equal(s.bar.y,previous.y-10);
 await page.screenshot({path:`${output}/${name}-toolbar-middle.png`});
 // Resizing the application clamps only the bar dimensions; the options flip independently.
 await page.setViewportSize({width:600,height:550});s=await geometry();inside(s);
 await page.evaluate(()=>{document.querySelector('.mobile-ink-toolbar-dock').scrollLeft=0;});s=await geometry();inside(s);
 assert.equal(await minimize.isVisible(),true);assert.equal(await grip.isVisible(),true);
 await page.setViewportSize({width:390,height:700});s=await geometry();inside(s);assert.equal(await minimize.isVisible(),true);
 await page.evaluate(()=>{document.body.classList.replace('theme-light','theme-dark');});await page.waitForTimeout(150);await page.screenshot({path:`${output}/${name}-toolbar-narrow-dark.png`});
 await minimize.click();await page.waitForTimeout(100);await page.screenshot({path:`${output}/${name}-toolbar-minimized.png`});
 await page.setViewportSize({width:1024,height:900});await restore.click();s=await geometry();inside(s);
 // Touch drag via the browser input stack also must not scroll or draw on the PDF.
 if(name==='chromium'){
  const cdp=await page.context().newCDPSession(page),b=await grip.boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;
  const before=await page.evaluate(()=>({scroll:window.nativeHarness.viewer.container.scrollTop,strokes:window.nativeHarness.session.controller.getStrokes().length}));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+15*i,y:y-20*i,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const after=await page.evaluate(()=>({scroll:window.nativeHarness.viewer.container.scrollTop,strokes:window.nativeHarness.session.controller.getStrokes().length}));assert.deepEqual(after,before);inside(await geometry());
 }
 const clean=await page.evaluate(async()=>{await window.nativeHarness.session.close();return document.querySelectorAll('.note-ink-native-tools').length;});assert.equal(clean,0);assert.deepEqual(errors,[]);
 const result={browser:name,passed:true,start,bottom,top,beforeMin,bubble,errors};await writeFile(`${output}/${name}-toolbar-checks.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({browser:name,passed:true,placement:true,drag:true,minimize:true,resize:true}));await browser.close();
}}finally{for(const b of browsers)await b.close();server.close();}
