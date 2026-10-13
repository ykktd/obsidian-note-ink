import {drawStroke,drawStrokeSegment,drawStrokeTail} from '../src/ink/renderer';
import {intersectsErase} from '../src/ink/eraser';
import type {InkStroke} from '../src/ink/types';

export function fixedWidthChecks(){
  const canvas=()=>{const c=document.createElement('canvas');c.width=192;c.height=96;return c;};
  const pixels=(c:HTMLCanvasElement)=>c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;
  const difference=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>a.reduce((n,v,i)=>n+(v!==b[i]?1:0),0);
  const thickness=(c:HTMLCanvasElement,x:number)=>{const data=pixels(c);let n=0;for(let y=0;y<c.height;y++)if(data[(y*c.width+x)*4+3]>=128)n++;return n;};
  const results=[] as Array<{pressure:string;timing:number;difference:number;streamedDifference:number;thicknesses:number[];dotWidth:number;eraserInside:boolean;eraserOutside:boolean}>;
  let reference:Uint8ClampedArray|undefined;
  for(const pressure of [[0,0,0,0,0],[1,1,1,1,1],[.01,.2,1,.4,.8]])for(const timing of [1,100]){
    const stroke:InkStroke={id:'fixed',tool:'pen',color:'#123456',width:12,points:pressure.map((p,i)=>({x:32+i*32,y:48,t:i*timing,pressure:p}))};
    const full=canvas();drawStroke(full.getContext('2d')!,stroke);
    const data=pixels(full);reference??=data;
    const streamed=canvas(),ctx=streamed.getContext('2d')!,partial={...stroke,points:[] as InkStroke['points']};
    for(const point of stroke.points){const count=partial.points.length;partial.points.push(point);drawStrokeSegment(ctx,partial,count);}
    drawStrokeTail(ctx,partial);
    const dot=canvas();drawStroke(dot.getContext('2d')!,{...stroke,points:[stroke.points[0]]});
    results.push({pressure:pressure.join(','),timing,difference:difference(reference,data),streamedDifference:difference(data,pixels(streamed)),thicknesses:[32,64,96,128,160].map(x=>thickness(full,x)),dotWidth:thickness(dot,32),eraserInside:intersectsErase(stroke,{x:32,y:54.9},{x:32,y:54.9},1),eraserOutside:intersectsErase(stroke,{x:32,y:55.1},{x:32,y:55.1},1)});
  }
  return results;
}
