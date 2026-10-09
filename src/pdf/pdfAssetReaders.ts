import assets from 'lecture-ink:pdf-assets';

function decode(data: string | undefined): Uint8Array {
  if (!data) throw new Error('PDF表示用のフォント情報が見つかりません。');
  const raw=atob(data), bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return bytes;
}
/** PDF.js factories read packaged data, never a remote URL or an arbitrary vault path. */
export class BundledCMapReaderFactory {
  async fetch({name}:{name:string}): Promise<{cMapData:Uint8Array;compressionType:number}> {
    const key=`${name}.bcmap`;
    return{cMapData:decode(Object.prototype.hasOwnProperty.call(assets.cmaps,key)?assets.cmaps[key]:undefined),compressionType:1};
  }
}
export class BundledStandardFontDataFactory {
  async fetch({filename}:{filename:string}): Promise<Uint8Array> {
    return decode(Object.prototype.hasOwnProperty.call(assets.fonts,filename)?assets.fonts[filename]:undefined);
  }
}
