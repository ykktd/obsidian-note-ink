import {readFile,readdir} from 'node:fs/promises';
export const pdfAssetsPlugin={name:'lecture-ink-pdf-assets',setup(build){
 build.onResolve({filter:/^lecture-ink:pdf-assets$/},()=>({path:'assets',namespace:'lecture-ink-pdf-assets'}));
 build.onLoad({filter:/.*/,namespace:'lecture-ink-pdf-assets'},async()=>{
  const maps={cmaps:{},fonts:{}};
  for(const [key,folder,extension] of [['cmaps','cmaps','.bcmap'],['fonts','standard_fonts',null]]){
   const root=`node_modules/pdfjs-dist/${folder}`;
   for(const name of (await readdir(root)).sort()){
    if(extension?!name.endsWith(extension):! /\.(pfb|ttf)$/.test(name))continue;
    maps[key][name]=(await readFile(`${root}/${name}`)).toString('base64');
   }
  }
  const licenses=await Promise.all(['LICENSE','cmaps/LICENSE','standard_fonts/LICENSE_FOXIT','standard_fonts/LICENSE_LIBERATION'].map(file=>readFile(`node_modules/pdfjs-dist/${file}`,'utf8')));
  return{contents:`/*! PDF.js CMap and standard-font assets; licenses:\n${licenses.join("\n\n")}\n*/\nexport default ${JSON.stringify(maps)}`,loader:'js'};
 });
}};
