import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
await mkdir('work/tests',{recursive:true});
await build({entryPoints:['tests/core.test.ts'],alias:{obsidian:path.resolve('tests/nodeObsidian.ts')},bundle:true,platform:'node',format:'esm',target:'node22',outfile:'work/tests/core.test.mjs'});
const result=spawnSync(process.execPath,['--test','work/tests/core.test.mjs'],{stdio:'inherit'});
process.exitCode=result.status??1;
