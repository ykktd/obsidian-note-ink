import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {webkit,chromium,devices} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
await mkdir('work/browser',{recursive:true});
await build({plugins:[pdfAssetsPlugin],entryPoints:['tests/browserHarness.ts'],bundle:true,format:'iife',platform:'browser',target:'es2020',external:['/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:'work/browser/harness.js'});
const base=`<html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>:root{--background-primary:#fff;--background-secondary:#f4f4f4;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--background-modifier-border:#ddd;--icon-color:#444;}body{margin:0;font-family:Arial,sans-serif;}main{height:90vh;display:flex;flex-direction:column;}header{display:flex;}header button{padding:8px;font-size:12px;}.view-content{height:100%;min-height:0;}button{cursor:pointer;}button:focus-visible{outline:2px solid #586b86;}.notice{position:fixed;bottom:12px;background:#333;color:white;padding:16px;z-index:1000;}#exports{display:flex;flex-wrap:wrap;}</style></head><body><section id="exports"></section><script src="/harness.js"></script></body></html>`;
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost').pathname;
 if(url==='/'){res.end(base);return;}
 const file=url==='/harness.js'?'work/browser/harness.js':url==='/styles.css'?'styles.css':url.startsWith('/pdfjs/')?`node_modules/pdfjs-dist/build/${path.basename(url)}`:null;
 if(!file){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(file));
 }catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
try{for(const browserName of ['webkit','chromium']){
 const browser=await (browserName==='webkit'?webkit.launch():chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}));
 try{
 const context=await browser.newContext({...devices['iPad (gen 7)'],browserName:undefined});const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);
 const rejection=await page.evaluate(()=>window.harness.rejectedSidecar());
 assert.ok(rejection.engine&&rejection.preserved&&rejection.corruptPreserved);assert.equal(rejection.tiles,0);assert.match(rejection.message,/大きすぎる/);
 await page.evaluate(()=>window.harness.open());await page.evaluate(()=>window.harness.addTestInk());
 await page.locator('button[aria-label="その他の操作"]').click();
 await page.locator('button[aria-label="書き込み入りPDFを保存"]').click();
 await page.waitForFunction(()=>window.harness.files.has('講義/第1回-書き込み.pdf'));
 await page.screenshot({path:`work/browser/${browserName}-ipad-ui.png`});
 const result=await page.evaluate(()=>window.harness.verifyExport('講義/第1回-書き込み.pdf'));
 assert.equal(result.visuals.length,4);
 for(const visual of result.visuals){assert.ok(visual.red>20,JSON.stringify(visual));assert.match(visual.text,/Original text remains selectable/);}
 assert.ok(result.visuals[0].notes.includes('ここは試験に出る'));
 await page.evaluate(()=>window.harness.view.containerEl.remove());
 await page.screenshot({path:`work/browser/${browserName}-export-pages.png`,fullPage:true});
 assert.deepEqual(errors,[]);
 const resultBytes=await page.evaluate(()=>Array.from(window.harness.files.get('講義/第1回-書き込み.pdf')));await writeFile(`work/browser/${browserName}-export.pdf`,new Uint8Array(resultBytes));
 console.log(browserName,JSON.stringify(result));
 }finally{await browser.close();}
 }}finally{server.close();}
