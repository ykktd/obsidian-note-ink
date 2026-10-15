import { drawStrokes, setupCanvas } from '../src/ink/renderer';
import type { InkStroke } from '../src/ink/types';

/** Compare coverage against a full-page render, including erased edge pixels. */
export function rasterChecks() {
  return ['pen','highlighter'].map(tool=>{
    const full=document.createElement('canvas'),crop=document.createElement('canvas');
    const stroke:InkStroke={id:'cross-crop',tool:tool as InkStroke['tool'],color:'#aa3355',width:8,
      points:[{x:0,y:40},{x:90,y:65},{x:80,y:20},{x:10,y:60}].map((p,i)=>({...p,t:i*10,pressure:.5})),
      erasures:[{radius:6,points:[{x:25,y:35},{x:50,y:65}]}]};
    try{
      const a=setupCanvas(full,100,100,{pixelRatio:4});
      const b=setupCanvas(crop,100,100,{pixelRatio:4,region:{x:20,y:30,width:40,height:40}});
      drawStrokes(a,[stroke]);drawStrokes(b,[stroke]);
      const expected=a.getImageData(80,120,160,160).data,actual=b.getImageData(0,0,160,160).data;
      let difference=0,visible=0,maxAlphaDifference=0,totalAlphaDifference=0;
      for(let i=0;i<actual.length;i++){
        if(actual[i]!==expected[i])difference++;
        if(i%4===3){if(actual[i])visible++;const delta=Math.abs(actual[i]-expected[i]);maxAlphaDifference=Math.max(maxAlphaDifference,delta);totalAlphaDifference+=delta;}
      }
      return {tool,difference,maxAlphaDifference,coverageError:totalAlphaDifference/(255*160*160),visible};
    }finally{full.width=full.height=crop.width=crop.height=0;}
  });
}
