import {pdfAssetsPlugin} from './scripts/pdf-assets-plugin.mjs';
import * as esbuild from 'esbuild';
await esbuild.build({plugins:[pdfAssetsPlugin],entryPoints:['src/main.ts'],bundle:true,external:['obsidian'],platform:'browser',format:'cjs',target:'es2020',outfile:'main.js',minify:true,legalComments:'eof',banner:{js:'/* Obsidian Lecture Ink — GPL-3.0-or-later; derived from Mobile Ink Annotation. See LICENSE and THIRD_PARTY_NOTICES.md. */'}});
