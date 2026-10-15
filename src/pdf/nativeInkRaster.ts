import type { CanvasRegion } from '../ink/renderer';

// Shared by the viewing and writing layers. Cost depends on the visible area,
// not the PDF page size or zoom. Two input canvases replace the display bitmap.
export const NATIVE_INK_MAX_PIXELS=4_000_000;
export type InkRaster={region:CanvasRegion;pixelRatio:number;key:string};
type Box={left:number;top:number;right:number;bottom:number;width:number;height:number};

export function nativeInkRaster(width:number,height:number,page:Box,visible:Box,deviceDpr:number):InkRaster {
  const sx=Math.max(.001,page.width/width),sy=Math.max(.001,page.height/height);
  // A little overscan keeps ink present between scroll events and animation frames.
  const margin=96;
  const x=Math.max(0,Math.min(width-1,Math.floor((visible.left-margin-page.left)/sx)));
  const y=Math.max(0,Math.min(height-1,Math.floor((visible.top-margin-page.top)/sy)));
  const right=Math.max(x+1,Math.min(width,Math.ceil((visible.right+margin-page.left)/sx)));
  const bottom=Math.max(y+1,Math.min(height,Math.ceil((visible.bottom+margin-page.top)/sy)));
  const region={x,y,width:right-x,height:bottom-y};
  const pixelRatio=Math.max(sx,sy)*Math.max(1,deviceDpr||1);
  return {region,pixelRatio,key:[x,y,region.width,region.height,pixelRatio].join(':')};
}
