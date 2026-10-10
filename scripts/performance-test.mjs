import {pdfAssetsPlugin} from './pdf-assets-plugin.mjs';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {webkit,devices} from '@playwright/test';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('work/browser',{recursive:true});
const baseline=process.argv[2]==='before';
const originalRoot=process.env.NOTE_INK_BASELINE_ROOT;
if(baseline && !originalRoot)throw new Error('Set NOTE_INK_BASELINE_ROOT to the unchanged 1.1.1 checkout');
if(baseline && JSON.parse(await readFile(path.join(originalRoot,'manifest.json'),'utf8')).version!=='1.1.1')throw new Error('Baseline must be version 1.1.1');
const baselinePlugin={name:'baseline-source',setup(build){build.onResolve({filter:/^\.\.\/src\//},args=>args.path==='../src/ink/renderer' ? null : ({path:path.resolve(originalRoot,args.path.slice(3)+'.ts')}));}};
await build({plugins:[...(baseline?[baselinePlugin]:[]),pdfAssetsPlugin],entryPoints:['tests/browserHarness.ts'],bundle:true,format:'iife',platform:'browser',target:'es2020',external:['/pdfjs/*'],alias:{obsidian:path.resolve('tests/mockObsidian.ts')},outfile:'work/browser/harness.js'});
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost').pathname;try{
 if(url==='/'){res.end(`<html><head><link rel="stylesheet" href="/styles.css"><style>body{margin:0}main{height:90vh;display:flex;flex-direction:column}.view-content{height:100%;min-height:0;position:relative}</style></head><body><section id="exports"></section><script src="/harness.js"></script></body></html>`);return;}
 const file=url==='/harness.js'?'work/browser/harness.js':url==='/styles.css'?'styles.css':url.startsWith('/pdfjs/')?`node_modules/pdfjs-dist/build/${path.basename(url)}`:null;
 if(!file){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(file));
 }catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await webkit.launch();
try {const page=await browser.newPage({...devices['iPad (gen 7)'],browserName:undefined});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.evaluate(b=>window.baseline=b,baseline);const result=await page.evaluate(()=>window.harness.performanceFixture());if(!baseline){assert.equal(result.globalUpdates,0);assert.equal(result.pageUpdates,0);assert.ok(result.zoomPixels<=16_000_000);assert.ok(result.maxLayerPixels<=4_000_000);assert.ok(result.zoom4Pixels<=16_000_000);}assert.ok(result.near.every(n=>n>=28&&n<=32),JSON.stringify(result));await writeFile(`work/browser/performance-${process.argv[2]??'current'}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));} finally {await browser.close();server.close();}
