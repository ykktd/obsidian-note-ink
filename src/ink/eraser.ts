import type {InkStroke} from './types';
import {distancePointToSegmentSquared, strokeWidths} from './renderer';
type Point={x:number;y:number};

function segmentDistance(a:Point,b:Point,c:Point,d:Point):number {
  const cross=(p:Point,q:Point,r:Point)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  if(abC*abD<0&&cdA*cdB<0)return 0;
  return Math.min(distancePointToSegmentSquared(a.x,a.y,c.x,c.y,d.x,d.y),distancePointToSegmentSquared(b.x,b.y,c.x,c.y,d.x,d.y),distancePointToSegmentSquared(c.x,c.y,a.x,a.y,b.x,b.y),distancePointToSegmentSquared(d.x,d.y,a.x,a.y,b.x,b.y));
}
/** Sample the rendered midpoint curves, not just the raw control polygon. */
export function intersectsErase(stroke:InkStroke,a:Point,b:Point,radius:number):boolean {
  const p=stroke.points;if(!p.length)return false;
  const widths=stroke.tool==='pen'?strokeWidths(stroke):p.map(()=>stroke.width);
  const mid=(x:Point,y:Point)=>({x:(x.x+y.x)/2,y:(x.y+y.y)/2});
  let prev:Point=p[0];
  for(let i=0;i<p.length-1;i++){
    const start=i?mid(p[i-1],p[i]):p[0],end=mid(p[i],p[i+1]);
    // Curvature-based subdivision avoids work proportional to a long straight line.
    const steps=Math.max(1,Math.min(256,Math.ceil(Math.sqrt(Math.hypot(start.x-2*p[i].x+end.x,start.y-2*p[i].y+end.y)/.5))));
    prev=start;
    for(let j=1;j<=steps;j++){
      const t=j/steps,u=1-t,q={x:u*u*start.x+2*u*t*p[i].x+t*t*end.x,y:u*u*start.y+2*u*t*p[i].y+t*t*end.y};
      if(segmentDistance(a,b,prev,q)<=(radius+widths[i]/2)**2)return true;
      prev=q;
    }
  }
  return segmentDistance(a,b,prev,p[p.length-1])<=(radius+widths[p.length-1]/2)**2;
}

/** Copy on write preserves undo history; the swept capsule cannot skip ink on fast moves. */
export function eraseStrokes(strokes:readonly InkStroke[],from:Point,to:Point,radius:number,mode:'partial'|'stroke'):InkStroke[]{
  return strokes.flatMap(stroke=>{
    // A bounding box rejects most strokes before curve sampling.
    const pad=radius+stroke.width,loX=Math.min(from.x,to.x)-pad,hiX=Math.max(from.x,to.x)+pad,loY=Math.min(from.y,to.y)-pad,hiY=Math.max(from.y,to.y)+pad;
    if(stroke.points.every(p=>p.x<loX)||stroke.points.every(p=>p.x>hiX)||stroke.points.every(p=>p.y<loY)||stroke.points.every(p=>p.y>hiY)||!intersectsErase(stroke,from,to,radius))return [stroke];
    if(mode==='stroke')return [];
    if(stroke.erasures?.some(e=>e.radius>=radius && e.points.some((p,i)=>{
      const q=e.points[Math.max(0,i-1)],r=(e.radius-radius)**2;
      return distancePointToSegmentSquared(from.x,from.y,p.x,p.y,q.x,q.y)<=r&&distancePointToSegmentSquared(to.x,to.y,p.x,p.y,q.x,q.y)<=r;
    })))return [stroke];
    const end={x:to.x,y:to.y};
    const points=from.x===to.x&&from.y===to.y?[end]:[{x:from.x,y:from.y},end];
    return [{...stroke,erasures:[...(stroke.erasures??[]),{radius,points}]}];
  });
}
