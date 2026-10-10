import type { InkStroke } from './types';
import { strokeBounds, type Bounds } from './lasso';
import { drawStrokes, setupCanvas } from './renderer';

/** Measure actual painted ink, including pressure, curves and per-stroke cutouts.
 * Only used when establishing a selection, never during pointer movement. */
export function visibleInkBounds(strokes:readonly InkStroke[],doc:Document):Bounds|null{
  const raw=strokeBounds(strokes);if(!raw)return null;
  let pad=2;for(const s of strokes)pad=Math.max(pad,s.width);
  const x=raw.x-pad,y=raw.y-pad,w=raw.width+pad*2,h=raw.height+pad*2;
  const canvas=doc.createElement('canvas');
  try{
    const ctx=setupCanvas(canvas,w,h,{maxDpr:2,displayScale:2,maxPixels:2_000_000});ctx.translate(-x,-y);drawStrokes(ctx,strokes);
    const {data}=ctx.getImageData(0,0,canvas.width,canvas.height);let left=canvas.width,top=canvas.height,right=-1,bottom=-1;
    for(let py=0;py<canvas.height;py++)for(let px=0;px<canvas.width;px++)if(data[(py*canvas.width+px)*4+3]>0){left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);}
    if(right<0)return null;
    return {x:x+left*w/canvas.width,y:y+top*h/canvas.height,width:(right-left+1)*w/canvas.width,height:(bottom-top+1)*h/canvas.height};
  }finally{canvas.width=canvas.height=0;}
}
