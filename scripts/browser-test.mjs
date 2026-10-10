import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {webkit,chromium,devices} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
await mkdir('work/browser',{recursive:true});
await build({plugins:[pdfAssetsPlugin],entryPoints:['tests/browserHarness.ts'],bundle:true,format:'iife',platform:'browser',target:'es2020',external:['/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:'work/browser/harness.js'});
const base=`<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>:root{--background-primary:#fff;--background-secondary:#f4f4f4;--text-normal:#222;--text-muted:#666;--interactive-accent:#586b86;--background-modifier-border:#ddd;--icon-color:#444;}body{margin:0;font-family:Arial,sans-serif;}main{height:90vh;display:flex;flex-direction:column;}header{display:flex;flex-shrink:0;}header button{padding:8px;font-size:12px;}.view-content{height:100%;min-height:0;}button{cursor:pointer;}button:focus-visible{outline:2px solid #586b86;}.notice{position:fixed;bottom:12px;background:#333;color:white;padding:16px;z-index:1000;}#exports{display:flex;flex-wrap:wrap;}</style></head><body><section id="exports"></section><script src="/harness.js"></script></body></html>`;
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
 const rendering=await page.evaluate(()=>window.harness.renderingChecks());
 for(const result of rendering){assert.equal(result.stable,true);assert.ok(result.maxDifference<=5,JSON.stringify(result));}
 const boundaries=await page.evaluate(()=>window.harness.boundaryChecks());
 assert.deepEqual(boundaries,{drawn:1,replicas:[1,1],undone:0,redone:1,erased:0,restored:1,reloaded:1,untouched:1});
 const pinch=await page.evaluate(()=>window.harness.pinchChecks());assert.ok(pinch.active&&pinch.ended&&pinch.saved&&!pinch.paused);assert.equal(pinch.zoom,2);
 const checks=await page.evaluate(()=>window.harness.interactionChecks());
 assert.equal(checks.two,2);assert.equal(checks.one,1);assert.equal(checks.zero,0);assert.equal(checks.restored,2);
 assert.equal(checks.dotPoints,1);assert.equal(checks.palmStrokes,1);assert.equal(checks.cancelled,1);assert.equal(checks.cancelledUndo,0);
 assert.equal(checks.penDifference,0);assert.equal(checks.erased,0);assert.equal(checks.eraseUndo,2);
 assert.ok(checks.maxAlpha<=90,JSON.stringify(checks));assert.equal(checks.toggle.tool,'highlighter');assert.equal(checks.toggle.highlighterColor,'#1473aa');assert.equal(checks.toggle.highlighterWidth,19);assert.equal(checks.browse,false);
 assert.equal(checks.during,0);assert.ok(checks.after>0);assert.ok(checks.rejected&&checks.retained&&checks.retryVisible&&checks.errorCleared);
 assert.equal(checks.source.type,'pdf');assert.equal(checks.finalSaved,2);assert.equal(checks.detachCalls,0);assert.equal(checks.sibling.state.file,'other.pdf');
 console.log(browserName,'interactions',JSON.stringify({rendering,checks}));
 await page.evaluate(()=>window.harness.open());await page.evaluate(()=>window.harness.addTestInk());
 await page.locator('button[aria-label="書き込み入りPDFを書き出す"]').click();
 await page.waitForFunction(()=>window.harness.files.has('講義/第1回-書き込み.pdf'));
 assert.equal(await page.locator('button[aria-label="その他の操作"]').count(),0);
 assert.equal(await page.locator('button[aria-label="タブのその他の操作"]').isVisible(),false);
 await page.locator('button[aria-label="ペン"]').focus();
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'ペン');
 if(browserName==='chromium'){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'蛍光ペン');}
 else await page.locator('button[aria-label="蛍光ペン"]').focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>window.harness.view.engine.getToolState().tool),'highlighter');
 assert.equal(await page.locator('button[aria-label="元に戻す"]').isDisabled(),true);
 assert.equal(await page.locator('.mobile-ink-quick-eraser').count(),0);
 await page.screenshot({path:`work/browser/${browserName}-toolbar.png`});
 const result=await page.evaluate(()=>window.harness.verifyExport('講義/第1回-書き込み.pdf'));
 assert.equal(result.visuals.length,4);
 for(const visual of result.visuals){assert.ok(visual.red>20,JSON.stringify(visual));assert.match(visual.text,/Original text remains selectable/);}
 assert.ok(result.visuals[0].notes.includes('ここは試験に出る'));
 await page.evaluate(()=>window.harness.view.containerEl.remove());
 await page.screenshot({path:`work/browser/${browserName}-export-pages.png`,fullPage:true});
 await page.evaluate(()=>window.harness.view.onClose());
 assert.deepEqual(errors,[]);
 await writeFile(`work/browser/checks-${browserName}.json`,JSON.stringify({rendering,boundaries,pinch,checks,export:result},null,2));
 const resultBytes=await page.evaluate(()=>Array.from(window.harness.files.get('講義/第1回-書き込み.pdf')));await writeFile(`work/browser/${browserName}-export.pdf`,new Uint8Array(resultBytes));
 console.log(browserName,JSON.stringify(result));
 }finally{await browser.close();}
 }}finally{server.close();}
